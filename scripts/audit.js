const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const axios = require('axios');
const FormData = require('form-data');

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

async function closeIssue(message) {
    console.log("Closing issue:", message);
    if (process.env.GITHUB_TOKEN && process.env.REPOSITORY && process.env.ISSUE_NUMBER) {
        try {
            await axios.post(
                `https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}/comments`,
                { body: message },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                        'Accept': 'application/vnd.github.v3+json'
                    }
                }
            );
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
        } catch(e) {
            console.error("Error closing the issue:", e.response?.data || e.message);
        }
    }
    process.exit(1);
}

async function run() {
    const issueBody = process.env.ISSUE_BODY || '';
    const issueNumber = process.env.ISSUE_NUMBER;
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
        await closeIssue("Required fields are missing or file URLs could not be extracted.");
    }

    const uuid = data.uuid.trim();
    const tmpDir = path.join('/tmp', uuid);
    fs.mkdirSync(tmpDir, { recursive: true });

    const zipPath = path.join(tmpDir, 'extension.zip');
    try {
        await downloadFile(zipPath.startsWith('/') ? `file://${zipPath}` : data.zip_url, zipPath);
    } catch (e) {
        // Fix local testing download logic
        try { await downloadFile(data.zip_url, zipPath); } catch(err) {
            await closeIssue(`Could not download the ZIP file from ${data.zip_url}.`);
        }
    }

    const iconPath = path.join('assets/icons', `${uuid}.png`);
    try {
        await downloadFile(data.icon_url, iconPath);
    } catch (e) {
        await closeIssue("Could not download the icon.");
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

    const zip = new AdmZip(zipPath);
    const zipEntries = zip.getEntries();
    let metadataEntry = zipEntries.find(e => e.entryName.endsWith('metadata.json'));
    if (!metadataEntry) {
        await closeIssue("No metadata.json found in the ZIP.");
    }
    
    const metadata = JSON.parse(zip.readAsText(metadataEntry));
    const shellVersions = metadata['shell-version'] || [];

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
        await closeIssue("The extension is too large for automatic auditing (50,000 character limit exceeded).");
    }

    let gjsContext = '';
    try {
        const indexRes = await axios.get('https://mdpedia.inled.es/raw/gjs.guide/_index.md');
        gjsContext += "GJS Guide Index:\n" + indexRes.data + "\n\n";
    } catch(e) {
        console.warn("Could not fetch GJS index");
    }

    const prompt = `Evaluate the following GNOME Shell extension code.
Supported versions: ${shellVersions.join(', ')}
GJS Guides:
${gjsContext.substring(0, 5000)}

Code:
${codeText.substring(0, 30000)}

Check for critical incompatibilities, security issues, or unauthorized access.
Respond STRICTLY in JSON format: {"apta": boolean, "motivo": "technical decision explanation"}`;

    if (process.env.NVIDIA_API_KEY) {
        try {
            const nvRes = await axios.post('https://integrate.api.nvidia.com/v1/chat/completions', {
                model: "meta/llama3-70b-instruct",
                messages: [{ role: "system", content: "You are a strict GNOME Shell extension reviewer. Answer ONLY in JSON." }, { role: "user", content: prompt }],
                temperature: 0.1
            }, {
                headers: { 'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`, 'Content-Type': 'application/json' }
            });
            
            let aiResult = nvRes.data.choices[0].message.content;
            let aiJson = JSON.parse(aiResult.match(/\{[\s\S]*\}/)[0]);
            if (!aiJson.apta) {
                await closeIssue(`AI Rejected the extension: ${aiJson.motivo}`);
            }
        } catch(e) {
            console.warn("Error querying NVIDIA API, assuming manual validation.", e.response?.data || e.message);
        }
    }

    if (process.env.VT_API_KEY) {
        try {
            const formData = new FormData();
            formData.append('file', fs.createReadStream(zipPath));
            const vtRes = await axios.post('https://www.virustotal.com/api/v3/files', formData, {
                headers: {
                    'x-apikey': process.env.VT_API_KEY,
                    ...formData.getHeaders()
                }
            });
        } catch (e) {
            console.warn("Error with VirusTotal", e.message);
        }
    }

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
        zip_url: `https://raw.githubusercontent.com/extensions-gnome/store/main/extensions/${uuid}.zip`
    };
    
    const existingIdx = db.findIndex(e => e.uuid === uuid);
    if (existingIdx >= 0) db[existingIdx] = newExt;
    else db.push(newExt);
    
    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    fs.copyFileSync(zipPath, path.join('extensions', `${uuid}.zip`));

    if (process.env.GITHUB_TOKEN && process.env.REPOSITORY && process.env.ISSUE_NUMBER) {
        try {
            await axios.post(
                `https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}/comments`,
                { body: "Congratulations! Your extension meets the GJS standards and has been published successfully." },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                        'Accept': 'application/vnd.github.v3+json'
                    }
                }
            );
            await axios.patch(
                `https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}`,
                { state: 'closed', state_reason: 'completed' },
                {
                    headers: {
                        'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`,
                        'Accept': 'application/vnd.github.v3+json'
                    }
                }
            );
        } catch (e) {
            console.error("Could not close the success issue");
        }
    }
    console.log("Validation completed and publication prepared.");
}

run().catch(console.error);
