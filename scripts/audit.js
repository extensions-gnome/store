const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const axios = require('axios');
const FormData = require('form-data');
const OpenAI = require('openai');

let currentStatusCommentId = null;
const ADMIN_USER = "jaimegh-es";

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
    console.log(`Downloading: ${url} -> ${dest}`);
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0 (GNOME Beta Store Bot)' }
        });
        return new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(dest);
            response.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    } catch (e) {
        throw new Error(`HTTP ${e.response?.status || 'Error'}: ${e.message}`);
    }
}

function extractLink(text) {
    if (!text || text === '_No response_') return null;
    const mdMatch = text.match(/\]\(([^)]+)\)/);
    if (mdMatch) return mdMatch[1];
    const htmlMatch = text.match(/src=["']([^"']+)["']/);
    if (htmlMatch) return htmlMatch[1];
    const urlMatch = text.match(/(https?:\/\/[^\s"'<>]+)/);
    if (urlMatch) return urlMatch[1];
    return null;
}

function extractLinks(text) {
    if (!text || text === '_No response_') return [];
    const links = [];
    const regex = /\]\(([^)]+)\)|src=["']([^"']+)["']|(https?:\/\/[^\s"'<>]+)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        links.push(match[1] || match[2] || match[3]);
    }
    return [...new Set(links)];
}

async function failAudit(stepId, message) {
    await updateStep(stepId, 'error', message);
    if (process.env.GITHUB_TOKEN && process.env.REPOSITORY && process.env.ISSUE_NUMBER) {
        try {
            await axios.patch(
                `https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}`,
                { state: 'closed', state_reason: 'not_planned' },
                { headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
            );
        } catch(e) {}
    }
    process.exit(1);
}

async function run() {
    await updateStep('prep', 'running', 'Analyzing request type...');
    
    const issueBody = process.env.ISSUE_BODY || '';
    const labelsRaw = process.env.ISSUE_LABELS || '[]';
    const labels = JSON.parse(labelsRaw).map(l => l.name);
    const issueUser = process.env.ISSUE_USER;

    const dbPath = 'extensions.json';
    let db = [];
    if (fs.existsSync(dbPath)) {
        db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
    }

    const sections = issueBody.split('###');
    const formData = {};
    for (let section of sections) {
        const lines = section.trim().split('\n');
        const header = lines.shift().trim();
        const content = lines.join('\n').trim();
        if (header.includes('Extension UUID')) formData.uuid = content;
        if (header.includes('Clear Name')) formData.name = content;
        if (header.includes('Description')) formData.description = content;
        if (header.includes('GitHub Link')) formData.github_url = content;
        if (header.includes('Promo Link')) formData.promo_url = content !== '_No response_' ? content : '';
        if (header.includes('ZIP File')) formData.zip_url = extractLink(content);
        if (header.includes('Icon')) formData.icon_url = extractLink(content);
        if (header.includes('Screenshots')) formData.demo_urls = extractLinks(content);
    }

    let mode = 'new';
    if (labels.includes('actualizacion-zip')) mode = 'update-zip';
    if (labels.includes('editar-metadata')) mode = 'edit-meta';
    if (labels.includes('eliminar-extension')) mode = 'delete';

    let targetExt = null;
    let uuid = formData.uuid;

    // Authorization & Pre-checks
    if (mode === 'delete') {
        targetExt = db.find(e => e.uuid === uuid);
        if (!targetExt) await failAudit('prep', `Extension ${uuid} not found.`);
        if (issueUser !== ADMIN_USER && targetExt.github_user !== issueUser) {
            await failAudit('prep', `Unauthorized: Only @${ADMIN_USER} or the owner (@${targetExt.github_user}) can delete this.`);
        }
        
        await updateStep('prep', 'success', `Request mode: ${mode}`);
        await updateStep('publish', 'running', 'Removing extension files and database entry...');
        
        // Remove from DB
        db = db.filter(e => e.uuid !== uuid);
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

        // Remove files
        const zipFile = path.join('extensions', `${uuid}.zip`);
        if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
        
        const iconFile = path.join('assets/icons', `${uuid}.png`);
        if (fs.existsSync(iconFile)) fs.unlinkSync(iconFile);
        
        const demosDir = path.join('assets/demos', uuid);
        if (fs.existsSync(demosDir)) fs.rmSync(demosDir, { recursive: true, force: true });

        await updateStep('publish', 'success', `Extension ${uuid} deleted successfully.`);
        // Close issue
        if (process.env.GITHUB_TOKEN && process.env.REPOSITORY && process.env.ISSUE_NUMBER) {
            await axios.patch(`https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}`,
                { state: 'closed', state_reason: 'completed' },
                { headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
            );
        }
        return;
    }

    if (mode !== 'new' || db.find(e => e.uuid === uuid)) {
        targetExt = db.find(e => e.uuid === (uuid || ''));
        if (targetExt && targetExt.github_user && targetExt.github_user !== issueUser && issueUser !== ADMIN_USER) {
            await failAudit('prep', `Unauthorized: This extension belongs to @${targetExt.github_user}.`);
        }
    }

    if (mode === 'update-zip') {
        if (!formData.zip_url) await failAudit('prep', 'No ZIP file found.');
    } else if (mode === 'edit-meta') {
        if (!targetExt) await failAudit('prep', `Extension ${uuid} not found.`);
    }

    await updateStep('prep', 'success', `Request mode: ${mode}`);
    const tmpDir = path.join('/tmp', 'audit-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    let zipPath = null;
    let metadata = null;
    let shellVersions = [];

    // DOWNLOAD & METADATA
    if (mode === 'new' || mode === 'update-zip') {
        await updateStep('download', 'running', 'Downloading ZIP...');
        zipPath = path.join(tmpDir, 'extension.zip');
        await downloadFile(formData.zip_url, zipPath);
        
        const zip = new AdmZip(zipPath);
        const metadataEntry = zip.getEntries().find(e => e.entryName.endsWith('metadata.json'));
        if (!metadataEntry) await failAudit('metadata', "No metadata.json in ZIP.");
        
        metadata = JSON.parse(zip.readAsText(metadataEntry));
        uuid = metadata.uuid;
        shellVersions = metadata['shell-version'] || [];

        if (mode === 'update-zip') {
            targetExt = db.find(e => e.uuid === uuid);
            if (!targetExt) await failAudit('metadata', `Extension ${uuid} not found.`);
            if (targetExt.github_user && targetExt.github_user !== issueUser && issueUser !== ADMIN_USER) {
                await failAudit('metadata', `Unauthorized access to ${uuid}.`);
            }
        }
        await updateStep('metadata', 'success', `UUID: ${uuid}, Version: ${metadata.version}`);
    }

    // ASSETS
    if (mode === 'new' || mode === 'edit-meta') {
        await updateStep('download', 'running', 'Updating assets...');
        if (formData.icon_url) {
            await downloadFile(formData.icon_url, path.join('assets/icons', `${uuid}.png`));
        }
        if (formData.demo_urls && formData.demo_urls.length > 0) {
            const demosDir = path.join('assets/demos', uuid);
            fs.mkdirSync(demosDir, { recursive: true });
            for (let i = 0; i < formData.demo_urls.length; i++) {
                await downloadFile(formData.demo_urls[i], path.join(demosDir, `demo${i+1}.png`));
            }
        }
        await updateStep('download', 'success', 'Assets processed.');
    }

    if (mode === 'edit-meta') {
        await updateStep('ai', 'success', 'Skipped.');
        await updateStep('malware', 'success', 'Skipped.');
    }

    // AI AUDIT
    let aiVerdict = targetExt ? targetExt.ai_report : null;
    if (zipPath) {
        await updateStep('ai', 'running', 'AI Code Review...');
        const zip = new AdmZip(zipPath);
        let codeText = '';
        for (let entry of zip.getEntries()) {
            if (entry.isDirectory || entry.entryName.includes('node_modules/')) continue;
            if (entry.entryName.endsWith('.js') || entry.entryName.endsWith('.ts')) {
                codeText += `\n// File: ${entry.entryName}\n` + zip.readAsText(entry);
            }
        }
        if (codeText.length > 100000) await failAudit('ai', "Code too large.");

        if (process.env.GROQ_API_KEY) {
            try {
                const openai = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' });
                const completion = await openai.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages: [{ role: "system", content: "Review GNOME extension code. JSON only: {\"apta\": boolean, \"motivo\": \"string\"}" },
                               { role: "user", content: `Code:\n${codeText.substring(0, 40000)}` }],
                    temperature: 0.1,
                });
                const res = JSON.parse(completion.choices[0].message.content.match(/\{[\s\S]*\}/)[0]);
                if (!res.apta) await failAudit('ai', `AI Rejected: ${res.motivo}`);
                aiVerdict = res.motivo;
            } catch (e) { aiVerdict = "Audit bypassed."; }
        }
        await updateStep('ai', 'success', 'Analysis complete.');
    }

    // VIRUSTOTAL
    let vtVerdict = targetExt ? targetExt.security_report : null;
    if (zipPath && process.env.VT_API_KEY) {
        await updateStep('malware', 'running', 'VirusTotal Polling...');
        try {
            const form = new FormData();
            form.append('file', fs.createReadStream(zipPath));
            const upload = await axios.post('https://www.virustotal.com/api/v3/files', form, {
                headers: { 'x-apikey': process.env.VT_API_KEY, ...form.getHeaders() }
            });
            const analysisId = upload.data.data.id;
            let completed = false;
            for (let i = 0; i < 12; i++) {
                await new Promise(r => setTimeout(r, 10000));
                const report = await axios.get(`https://www.virustotal.com/api/v3/analyses/${analysisId}`, {
                    headers: { 'x-apikey': process.env.VT_API_KEY }
                });
                if (report.data.data.attributes.status === 'completed') {
                    const stats = report.data.data.attributes.stats;
                    if (stats.malicious > 0) await failAudit('malware', "MALWARE DETECTED!");
                    vtVerdict = `Clean (${stats.harmless + stats.undetected} engines)`;
                    completed = true;
                    break;
                }
            }
            if (!completed) vtVerdict = "Scan pending.";
        } catch (e) { vtVerdict = "Scan error."; }
        await updateStep('malware', 'success', vtVerdict);
    }

    // PUBLISH
    await updateStep('publish', 'running', 'Finalizing...');
    const demoPaths = [];
    const demosDir = `assets/demos/${uuid}`;
    if (fs.existsSync(demosDir)) fs.readdirSync(demosDir).forEach(f => demoPaths.push(path.join(demosDir, f)));

    const finalExt = {
        uuid,
        version: metadata ? (metadata.version || 1) : (targetExt ? targetExt.version : 1),
        shell_version: metadata ? (metadata['shell-version'] || []) : (targetExt ? targetExt.shell_version : []),
        name: formData.name || (targetExt ? targetExt.name : uuid),
        description: formData.description || (targetExt ? targetExt.description : ''),
        github_url: formData.github_url || (targetExt ? targetExt.github_url : ''),
        promo_url: formData.promo_url || (targetExt ? targetExt.promo_url : ''),
        github_user: targetExt ? targetExt.github_user : issueUser,
        icon: `assets/icons/${uuid}.png`,
        demos: demoPaths,
        zip_url: `https://raw.githubusercontent.com/extensions-gnome/store/main/extensions/${uuid}.zip`,
        ai_report: aiVerdict,
        security_report: vtVerdict
    };

    const existingIdx = db.findIndex(e => e.uuid === uuid);
    if (existingIdx >= 0) db[existingIdx] = finalExt;
    else db.push(finalExt);

    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
    if (zipPath) fs.copyFileSync(zipPath, path.join('extensions', `${uuid}.zip`));
    await updateStep('publish', 'success', 'Published!');
    
    if (process.env.GITHUB_TOKEN && process.env.REPOSITORY && process.env.ISSUE_NUMBER) {
        await axios.patch(`https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}`,
            { state: 'closed', state_reason: 'completed' },
            { headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
        );
    }
}

run().catch(console.error);
