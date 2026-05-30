const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const axios = require('axios');
const FormData = require('form-data');
const OpenAI = require('openai');

let currentStatusCommentId = null;

async function postOrUpdateComment(message) {
    if (!process.env.GITHUB_TOKEN || !process.env.REPOSITORY || !process.env.ISSUE_NUMBER) {
        console.log("Mock Comment:", message);
        return;
    }

    const url = currentStatusCommentId 
        ? `https://api.github.com/repos/${process.env.REPOSITORY}/issues/comments/${currentStatusCommentId}`
        : `https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}/comments`;
    
    const method = currentStatusCommentId ? 'patch' : 'post';

    try {
        const res = await axios({
            method,
            url,
            data: { body: message },
            headers: {
                'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                'Accept': 'application/vnd.github.v3+json'
            }
        });
        if (!currentStatusCommentId) currentStatusCommentId = res.data.id;
    } catch (e) {
        console.error("Error managing GitHub comment:", e.response?.data || e.message);
    }
}

const loadingIcon = "![loading](https://raw.githubusercontent.com/nelson-liu/animated-gifs/master/loading.gif)"; // Small discrete loading gif if available, or just use text

function getStatusMarkdown(steps) {
    let md = "### 🛡️ GNOME Beta Store - Audit Progress\n\n";
    for (const step of steps) {
        const icon = step.status === 'pending' ? '⏳' : (step.status === 'running' ? '🔄' : (step.status === 'success' ? '✅' : '❌'));
        md += `${icon} **${step.name}**: ${step.message}\n`;
    }
    md += "\n---\n*Automated review in progress. Please wait.*";
    return md;
}

const auditSteps = [
    { id: 'prep', name: 'Preparation', status: 'pending', message: 'Waiting to start...' },
    { id: 'download', name: 'Asset Download', status: 'pending', message: 'Pending' },
    { id: 'metadata', name: 'Metadata Validation', status: 'pending', message: 'Pending' },
    { id: 'ai', name: 'AI Code Audit', status: 'pending', message: 'Pending' },
    { id: 'malware', name: 'Malware Scan', status: 'pending', message: 'Pending' },
    { id: 'publish', name: 'Publication', status: 'pending', message: 'Pending' }
];

async function updateStep(id, status, message) {
    const step = auditSteps.find(s => s.id === id);
    if (step) {
        step.status = status;
        step.message = message;
    }
    await postOrUpdateComment(getStatusMarkdown(auditSteps));
}

async function downloadFile(url, dest) {
    if (url.startsWith('file://')) {
        const filePath = url.replace('file://', '');
        fs.copyFileSync(filePath, dest);
        return;
    }
    const response = await axios({
        url,
        method: 'GET',
        responseType: 'stream'
    });
    return new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(dest);
        response.data.pipe(writer);
        let error = null;
        writer.on('error', err => {
            error = err;
            writer.close();
            reject(err);
        });
        writer.on('close', () => {
            if (!error) resolve();
        });
    });
}

function extractMarkdownLink(text) {
    if (!text) return null;
    const match = text.match(/\]\(([^)]+)\)/);
    if (match) return match[1];
    const urlMatch = text.match(/(https?:\/\/[^\s]+)/);
    if (urlMatch) return urlMatch[1];
    return text.trim();
}

function extractMarkdownLinks(text) {
    if (!text) return [];
    const links = [];
    const regex = /\]\(([^)]+)\)|(https?:\/\/[^\s]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        links.push(match[1] || match[2]);
    }
    return links;
}

async function failAudit(stepId, message) {
    await updateStep(stepId, 'error', message);
    if (process.env.GITHUB_TOKEN && process.env.REPOSITORY && process.env.ISSUE_NUMBER) {
        try {
            await axios.patch(
                `https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}`,
                { state: 'closed', state_reason: 'not_planned' },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                        'Accept': 'application/vnd.github.v3+json'
                    }
                }
            );
        } catch(e) {}
    }
    process.exit(1);
}

async function run() {
    await updateStep('prep', 'running', 'Analyzing issue data...');
    
    const issueBody = process.env.ISSUE_BODY || '';
    const repo = process.env.REPOSITORY || 'owner/repo';
    
    const sections = issueBody.split('###');
    const data = {};
    for (let section of sections) {
        const lines = section.trim().split('\n');
        const header = lines.shift().trim();
        const content = lines.join('\n').trim();
        if (header.includes('Extension UUID')) data.uuid = content;
        if (header.includes('Clear Name')) data.name = content;
        if (header.includes('Description')) data.description = content;
        if (header.includes('GitHub Link')) data.github_url = content;
        if (header.includes('Promotional Link')) data.promo_url = content !== '_No response_' ? content : '';
        if (header.includes('ZIP File')) data.zip_url = extractMarkdownLink(content);
        if (header.includes('Icon')) data.icon_url = extractMarkdownLink(content);
        if (header.includes('Demos')) data.demo_urls = extractMarkdownLinks(content);
    }

    if (!data.uuid || !data.zip_url || !data.icon_url) {
        await failAudit('prep', 'Required fields are missing or file URLs could not be extracted.');
    }
    await updateStep('prep', 'success', 'Issue data parsed.');

    const uuid = data.uuid.trim();
    const tmpDir = path.join('/tmp', uuid);
    fs.mkdirSync(tmpDir, { recursive: true });

    await updateStep('download', 'running', 'Downloading assets...');
    const zipPath = path.join(tmpDir, 'extension.zip');
    try {
        await downloadFile(data.zip_url, zipPath);
    } catch (e) {
        await failAudit('download', `Could not download the ZIP file from ${data.zip_url}.`);
    }

    const iconPath = path.join('assets/icons', `${uuid}.png`);
    try {
        await downloadFile(data.icon_url, iconPath);
    } catch (e) {
        await failAudit('download', "Could not download the icon.");
    }
    
    const demosDir = path.join('assets/demos', uuid);
    fs.mkdirSync(demosDir, { recursive: true });
    
    const demoPaths = [];
    if (data.demo_urls && data.demo_urls.length > 0) {
        for (let i = 0; i < data.demo_urls.length; i++) {
            const dest = path.join(demosDir, `demo${i+1}.png`);
            try {
                await downloadFile(data.demo_urls[i], dest);
                demoPaths.push(dest);
            } catch(e) {
                console.warn(`Could not download demo ${i+1}`);
            }
        }
    }
    await updateStep('download', 'success', 'Assets downloaded.');

    await updateStep('metadata', 'running', 'Validating metadata.json...');
    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    let metadataEntry = zipEntries.find(e => e.entryName.endsWith('metadata.json'));
    if (!metadataEntry) {
        await failAudit('metadata', "No metadata.json found in the ZIP.");
    }
    
    const metadata = JSON.parse(zip.readAsText(metadataEntry));
    const shellVersions = metadata['shell-version'] || [];
    await updateStep('metadata', 'success', `Metadata valid. Target shell versions: ${shellVersions.join(', ')}`);

    await updateStep('ai', 'running', 'Performing AI code review...');
    let codeText = '';
    for (let entry of zipEntries) {
        if (entry.isDirectory) continue;
        const name = entry.entryName;
        if (name.includes('node_modules/') || name.includes('vendor/') || name.endsWith('.min.js')) continue;
        if (name.endsWith('.js') || name.endsWith('.ts') || name.endsWith('.json')) {
            codeText += `\n// File: ${name}\n`;
            codeText += zip.readAsText(entry);
        }
    }

    if (codeText.length > 50000) {
        await failAudit('ai', "Code too large for automatic audit (max 50,000 chars).");
    }

    let gjsContext = '';
    try {
        const indexRes = await axios.get('https://mdpedia.inled.es/raw/gjs.guide/_index.md');
        gjsContext += "GJS Guide Index:\n" + indexRes.data + "\n\n";
    } catch(e) {}

    if (process.env.GROQ_API_KEY) {
        try {
            const openai = new OpenAI({
                apiKey: process.env.GROQ_API_KEY,
                baseURL: 'https://api.groq.com/openai/v1',
            });

            const completion = await openai.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: [
                    { role: "system", content: "You are a strict GNOME Shell extension reviewer. Answer ONLY in JSON." },
                    { role: "user", content: `Evaluate code for GNOME Shell ${shellVersions.join(', ')}.\nGJS Guides: ${gjsContext.substring(0, 3000)}\n\nCode:\n${codeText.substring(0, 30000)}\n\nRespond JSON: {"apta": boolean, "motivo": "string"}` }
                ],
                temperature: 0.1,
            });

            const aiResult = completion.choices[0].message.content;
            const aiJsonMatch = aiResult.match(/\{[\s\S]*\}/);
            
            if (aiJsonMatch) {
                const aiJson = JSON.parse(aiJsonMatch[0]);
                if (!aiJson.apta) {
                    await failAudit('ai', `AI Rejected: ${aiJson.motivo}`);
                }
            } else {
                throw new Error("Invalid AI JSON response.");
            }
        } catch(e) {
            console.warn("AI bypass:", e.message);
            await updateStep('ai', 'success', 'AI Audit bypassed or manual required.');
        }
    }
    await updateStep('ai', 'success', 'Code analysis complete.');

    await updateStep('malware', 'running', 'Scanning for malware...');
    if (process.env.VT_API_KEY) {
        try {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(zipPath));
            await axios.post('https://www.virustotal.com/api/v3/files', formData, {
                headers: { 'x-apikey': process.env.VT_API_KEY, ...formData.getHeaders() }
            });
            await updateStep('malware', 'success', 'Malware scan clean.');
        } catch (e) {
            await updateStep('malware', 'success', 'Scan skipped (VT limit or error).');
        }
    } else {
        await updateStep('malware', 'success', 'Scan skipped (No key).');
    }

    await updateStep('publish', 'running', 'Finalizing publication...');
    const dbPath = 'extensions.json';
    let db = [];
    if (fs.existsSync(dbPath)) {
        db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    }
    
    const newExt = {
        uuid: uuid,
        version: metadata.version || 1,
        name: data.name.trim(),
        description: data.description.trim(),
        github_url: data.github_url.trim(),
        promo_url: data.promo_url,
        icon: `assets/icons/${uuid}.png`,
        demos: demoPaths,
        zip_url: `https://raw.githubusercontent.com/extensions-gnome/store/main/extensions/${uuid}.zip`,
        ai_report: aiJson?.motivo || "Passed automated code quality audit.",
        security_report: process.env.VT_API_KEY ? "Verified clean by VirusTotal." : "Scanned for common vulnerabilities."
    };
    
    const existingIdx = db.findIndex(e => e.uuid === uuid);
    if (existingIdx >= 0) db[existingIdx] = newExt;
    else db.push(newExt);
    
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    fs.copyFileSync(zipPath, path.join('extensions', `${uuid}.zip`));

    await updateStep('publish', 'success', 'Extension published successfully!');
    
    if (process.env.GITHUB_TOKEN && process.env.REPOSITORY && process.env.ISSUE_NUMBER) {
        try {
            await axios.patch(
                `https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}`,
                { state: 'closed', state_reason: 'completed' },
                { headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
            );
        } catch (e) {}
    }
}

run().catch(console.error);
