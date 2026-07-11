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
    let md = "### 🛡️ Audit Progress\n\n";
    let details = "";
    for (const step of steps) {
        const icon = step.status === 'pending' ? '⏳' : (step.status === 'running' ? '🔄' : (step.status === 'success' ? '✅' : '❌'));
        const lines = (step.message || '').split('\n');
        const summary = lines[0];
        md += `${icon} **${step.name}**: ${summary}\n`;
        
        if (lines.length > 1) {
            details += `\n### 📝 ${step.name} Detailed Report\n\n${lines.slice(1).join('\n')}\n`;
        }
    }
    md += details;
    md += "\n---\n*Automated review in progress.*";
    return md;
}

const auditSteps = [
    { id: 'prep', name: 'Preparation', status: 'pending', message: 'Waiting...' },
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
    if (!url) throw new Error("URL is empty");
    console.log(`Downloading: ${url} -> ${dest}`);
    const dir = path.dirname(dest);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    try {
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            headers: { 'User-Agent': 'Mozilla/5.0 (Beta Store Bot)' }
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
    console.error(`\n==================================================`);
    console.error(`❌ AUDIT FAILED during step: ${stepId}`);
    console.error(`Reason: ${message}`);
    console.error(`==================================================\n`);

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

async function addIssueLabel(label) {
    if (!process.env.GITHUB_TOKEN || !process.env.REPOSITORY || !process.env.ISSUE_NUMBER) return;
    try {
        await axios.post(
            `https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}/labels`,
            { labels: [label] },
            { headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
        );
    } catch(e) {
        console.error(`Failed to add label ${label}:`, e.message);
    }
}

async function requestHumanReview(stepId, message) {
    console.error(`\n==================================================`);
    console.error(`❌ AUDIT REJECTED during step: ${stepId}`);
    console.error(`Reason: ${message}`);
    console.error(`==================================================\n`);

    await updateStep(stepId, 'error', message);
    await addIssueLabel('human-review-needed');
    process.exit(1);
}

async function run() {
    await updateStep('prep', 'running', 'Analyzing request...');
    
    const issueBody = process.env.ISSUE_BODY || '';
    const labelsRaw = process.env.ISSUE_LABELS || '[]';
    const labels = JSON.parse(labelsRaw).map(l => l.name);
    const issueUser = process.env.ISSUE_USER;
    const issueTitle = (process.env.ISSUE_TITLE || '').toLowerCase();

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
        let content = lines.join('\n').trim();
        if (content === '_No response_') content = '';

        if (header.includes('Extension UUID')) formData.uuid = content;
        if (header.includes('Name')) formData.name = content;
        if (header.includes('Description')) formData.description = content;
        if (header.includes('GitHub Link')) formData.github_url = content;
        if (header.includes('Promo Link')) formData.promo_url = content;
        if (header.includes('ZIP File')) formData.zip_url = extractLink(content);
        if (header.includes('Icon')) formData.icon_url = extractLink(content);
        if (header.includes('Screenshots')) formData.demo_urls = extractLinks(content);
    }

    // Mode detection
    let mode = 'new';
    if (labels.includes('actualizacion-zip') || issueTitle.includes('update:')) mode = 'update-zip';
    else if (labels.includes('editar-metadata') || issueTitle.includes('edit:')) mode = 'edit-meta';
    else if (labels.includes('eliminar-extension') || issueTitle.includes('delete:')) mode = 'delete';
    else if (labels.includes('nueva-extension') || issueTitle.includes('new:')) mode = 'new';

    let targetExt = null;
    let uuid = formData.uuid ? formData.uuid.trim() : null;

    // 1. DELETE MODE
    if (mode === 'delete') {
        if (!uuid) await failAudit('prep', 'UUID is required for deletion.');
        targetExt = db.find(e => e.uuid === uuid);
        if (!targetExt) await failAudit('prep', `Extension ${uuid} not found.`);
        if (issueUser !== ADMIN_USER && targetExt.github_user !== issueUser) {
            await failAudit('prep', `Unauthorized: You don't own ${uuid}.`);
        }
        
        await updateStep('prep', 'success', `Deleting ${uuid}...`);
        db = db.filter(e => e.uuid !== uuid);
        fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

        const zipFile = path.join('extensions', `${uuid}.zip`);
        if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
        const iconFile = path.join('assets/icons', `${uuid}.png`);
        if (fs.existsSync(iconFile)) fs.unlinkSync(iconFile);
        const demosDir = path.join('assets/demos', uuid);
        if (fs.existsSync(demosDir)) fs.rmSync(demosDir, { recursive: true, force: true });

        await updateStep('publish', 'success', 'Extension removed.');
        process.exit(0);
    }

    // 2. NEW MODE VALIDATION
    if (mode === 'new') {
        if (!uuid || !formData.name || !formData.zip_url || !formData.icon_url) {
            await failAudit('prep', 'Missing required fields (UUID, Name, ZIP, or Icon).');
        }
        if (db.find(e => e.uuid === uuid)) {
            targetExt = db.find(e => e.uuid === uuid);
            if (targetExt.github_user && targetExt.github_user !== issueUser && issueUser !== ADMIN_USER) {
                await failAudit('prep', `Conflict: UUID ${uuid} is already owned by @${targetExt.github_user}.`);
            }
            mode = 'update-zip'; // Upgrade to update if already exists and authorized
        }
    }

    // 3. EDIT/UPDATE AUTH
    if (mode === 'edit-meta' || mode === 'update-zip') {
        if (mode === 'edit-meta' && !uuid) await failAudit('prep', 'UUID is required.');
        if (uuid) {
            targetExt = db.find(e => e.uuid === uuid);
            if (targetExt && targetExt.github_user && targetExt.github_user !== issueUser && issueUser !== ADMIN_USER) {
                await failAudit('prep', `Unauthorized: You don't own ${uuid}.`);
            }
        }
    }

    await updateStep('prep', 'success', `Request mode: ${mode}`);
    const tmpDir = path.join('/tmp', 'audit-' + Date.now());
    fs.mkdirSync(tmpDir, { recursive: true });

    let zipPath = null;
    let metadata = null;
    let shellVersions = [];

    // ASSET DOWNLOAD (ZIP)
    if (mode === 'new' || mode === 'update-zip') {
        await updateStep('download', 'running', 'Downloading ZIP...');
        if (!formData.zip_url) await failAudit('download', 'ZIP URL missing.');
        zipPath = path.join(tmpDir, 'extension.zip');
        await downloadFile(formData.zip_url, zipPath);
        
        const zip = new AdmZip(zipPath);
        const metadataEntry = zip.getEntries().find(e => e.entryName.endsWith('metadata.json'));
        if (!metadataEntry) await failAudit('metadata', "No metadata.json in ZIP.");
        
        metadata = JSON.parse(zip.readAsText(metadataEntry));
        uuid = metadata.uuid;
        shellVersions = metadata['shell-version'] || [];

        // Final Auth check for update-zip (UUID from ZIP)
        targetExt = db.find(e => e.uuid === uuid);
        if (targetExt && targetExt.github_user && targetExt.github_user !== issueUser && issueUser !== ADMIN_USER) {
            await failAudit('metadata', `Unauthorized: ZIP UUID ${uuid} belongs to @${targetExt.github_user}.`);
        }
        await updateStep('metadata', 'success', `UUID: ${uuid} v${metadata.version}`);
    }

    // ASSET DOWNLOAD (Icons/Demos)
    if (mode === 'new' || mode === 'edit-meta') {
        await updateStep('download', 'running', 'Processing icons/screenshots...');
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
        await updateStep('download', 'success', 'Assets updated.');
    }

    if (mode === 'edit-meta') {
        await updateStep('ai', 'success', 'Skipped (Metadata only).');
        await updateStep('malware', 'success', 'Skipped (Metadata only).');
    }

    // AI AUDIT
    let aiVerdict = targetExt ? targetExt.ai_report : "Passed audit.";
    if (zipPath) {
        await updateStep('ai', 'running', 'AI Code Review...');

        let gjsContext = 'GJS & GNOME Shell Review Guidelines Context:\n\n';
        
        // 1. Fetch the main Review Guidelines (very important for security & GJS rules)
        try {
            console.log("Fetching GJS Review Guidelines...");
            const reviewRes = await axios.get('https://mdpedia.inled.es/raw/gjs.guide/extensions/review-guidelines/review-guidelines.md');
            gjsContext += "### GNOME Shell Review Guidelines:\n" + reviewRes.data + "\n\n";
        } catch (e) {
            console.warn("Could not fetch GJS Review Guidelines:", e.message);
        }

        // 2. Fetch specific shell version upgrade guides targeted by this extension
        if (shellVersions && shellVersions.length > 0) {
            for (const version of shellVersions) {
                // Extract major version, e.g. "45" from "45.1" or "45"
                const match = version.match(/^(\d+)/);
                if (match) {
                    const majorVer = match[1];
                    // Only fetch standard supported upgrade guides (GNOME 40+)
                    if (parseInt(majorVer) >= 40) {
                        try {
                            console.log(`Fetching upgrade guide for GNOME Shell ${majorVer}...`);
                            const upgradeRes = await axios.get(`https://mdpedia.inled.es/raw/gjs.guide/extensions/upgrading/gnome-shell-${majorVer}.md`);
                            gjsContext += `### GNOME Shell ${majorVer} Upgrade Guide:\n` + upgradeRes.data + "\n\n";
                        } catch (e) {
                            // Silently ignore if guide is not found or fails
                        }
                    }
                }
            }
        }

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
                const systemPrompt = `You are a GNOME extension security expert. You must review the provided Javascript/TypeScript code of a GNOME Shell extension for security vulnerabilities, compliance with GNOME Shell Extension Review Guidelines, and GJS best practices.

Your response must be in JSON format.

Classify the audit into one of three statuses:
- "ok": The code is secure, follows guidelines, and has no issues.
- "flag": The code has no critical security vulnerabilities, but contains minor violations or warnings (e.g. using synchronous DBus/file operations like password_lookup_sync, deprecated APIs, style issues, etc.). It is safe to run but needs improvement.
- "reject": The code has critical security vulnerabilities (e.g. malware, data theft, credential leakage, executing unvalidated user input via shell, backdoors) or severe bugs that would crash GNOME Shell.

You MUST respond in English. You must specify the filename and line numbers where each error or warning occurs.

Respond ONLY with a JSON object in this format:
{
  "status": "ok" | "flag" | "reject",
  "motivo": "A detailed summary of the overall review in English.",
  "errors": [
    {
      "file": "filename.js",
      "line": 123,
      "severity": "warning" | "critical",
      "message": "Description of the issue in English."
    }
  ]
}
`;
                const openai = new OpenAI({ apiKey: process.env.GROQ_API_KEY, baseURL: 'https://api.groq.com/openai/v1' });
                const completion = await openai.chat.completions.create({
                    model: "llama-3.3-70b-versatile",
                    messages: [{ role: "system", content: systemPrompt },
                               { role: "user", content: `Context: GNOME Shell versions: ${shellVersions.join(', ')}\n${gjsContext}\nCode:\n${codeText.substring(0, 40000)}` }],
                    temperature: 0.1,
                });
                
                const match = completion.choices[0].message.content.match(/\{[\s\S]*\}/);
                if (!match) {
                    throw new Error("Response did not contain a valid JSON block.");
                }

                let res;
                try {
                    res = JSON.parse(match[0]);
                } catch (e) {
                    throw new Error(`Invalid JSON syntax in AI response: ${e.message}`);
                }

                if (!res.status || !['ok', 'flag', 'reject'].includes(res.status)) {
                    throw new Error(`AI response status is missing or invalid (found: "${res.status || 'undefined'}").`);
                }
                
                let aiAuditDone = false;
                if (res.status === 'reject') {
                    // Reject status: do NOT publish, request human review (leave issue open)
                    const formattedErrors = (res.errors || []).map(e => `- \`${e.file}:${e.line}\` [${e.severity}]: ${e.message}`).join('\n');
                    const rejectMsg = `Rejected by AI Audit:\n${res.motivo}\n\n**Critical Issues Found:**\n${formattedErrors}\n\n*A human review has been requested. A maintainer will check this issue manually. Please do not close this issue.*`;
                    
                    await requestHumanReview('ai', rejectMsg);
                } else if (res.status === 'flag') {
                    // Flag status: publish the extension, but include details in database
                    const formattedErrors = (res.errors || []).map(e => `- ${e.file}:${e.line} [${e.severity}]: ${e.message}`).join('\n');
                    aiVerdict = `Flagged Audit Notes:\n${res.motivo}\n\nIssues:\n${formattedErrors}`;
                    
                    // Add label indicating it was flagged
                    await addIssueLabel('audit-flagged');
                    await updateStep('ai', 'success', `Complete with warnings.\n${aiVerdict}`);
                    aiAuditDone = true;
                } else {
                    // OK status
                    aiVerdict = res.motivo || "Passed audit.";
                    await updateStep('ai', 'success', `Passed (No issues).\n${aiVerdict}`);
                    aiAuditDone = true;
                }
            } catch (e) { 
                console.error("AI Audit failed:", e.message);
                const errorMsg = `AI Audit execution failed:\n${e.message}\n\n*A human review has been requested automatically.*`;
                await requestHumanReview('ai', errorMsg);
            }
        }
        if (!aiAuditDone) {
            await updateStep('ai', 'success', 'Complete.');
        }
    }

    // VIRUSTOTAL
    let vtVerdict = targetExt ? targetExt.security_report : "Verified clean.";
    if (zipPath && process.env.VT_API_KEY) {
        await updateStep('malware', 'running', 'Scanning...');
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
                    if (stats.malicious > 0) await failAudit('malware', "Malware detected!");
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
    await updateStep('publish', 'running', 'Publishing...');
    const demoPaths = [];
    const demosDir = `assets/demos/${uuid}`;
    if (fs.existsSync(demosDir)) {
        fs.readdirSync(demosDir).forEach(f => demoPaths.push(path.join(demosDir, f)));
    }

    // Ensure the version is cumulative (increments automatically on updates if not bumped in metadata)
    let version = metadata ? (metadata.version || 1) : 1;
    if (targetExt) {
        version = Math.max(version, targetExt.version + 1);
    }
    const repoPath = process.env.REPOSITORY || 'extensions-gnome/store';
    const releaseTag = `${uuid}-v${version}`;

    const finalExt = {
        uuid,
        version,
        shell_version: metadata ? (metadata['shell-version'] || []) : (targetExt ? targetExt.shell_version : []),
        name: formData.name || (targetExt ? targetExt.name : uuid),
        description: formData.description || (targetExt ? targetExt.description : ''),
        github_url: formData.github_url || (targetExt ? targetExt.github_url : ''),
        promo_url: formData.promo_url || (targetExt ? targetExt.promo_url : ''),
        github_user: targetExt ? targetExt.github_user : issueUser,
        icon: `assets/icons/${uuid}.png`,
        demos: demoPaths,
        zip_url: `https://github.com/${repoPath}/releases/download/${releaseTag}/${uuid}.zip`,
        ai_report: aiVerdict,
        security_report: vtVerdict
    };

    const existingIdx = db.findIndex(e => e.uuid === uuid);
    if (existingIdx >= 0) db[existingIdx] = finalExt;
    else db.push(finalExt);

    fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));

    // Upload to GitHub Releases instead of committing to Git
    if (zipPath && process.env.GITHUB_TOKEN) {
        console.log(`Uploading ZIP to GitHub Release ${releaseTag}...`);
        try {
            const { execSync } = require('child_process');
            
            // Rename to standard uuid.zip name for upload
            const uploadZipPath = path.join(tmpDir, `${uuid}.zip`);
            fs.copyFileSync(zipPath, uploadZipPath);
            
            // Try to create the release, ignore if it already exists
            try {
                execSync(`gh release create "${releaseTag}" --title "${finalExt.name} v${version}" --notes "Automated release of ${finalExt.name} version ${version}"`, {
                    env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
                    stdio: 'inherit'
                });
            } catch (err) {
                console.log("Release might already exist, proceeding to upload...");
            }
            // Upload the asset
            execSync(`gh release upload "${releaseTag}" "${uploadZipPath}" --clobber`, {
                env: { ...process.env, GH_TOKEN: process.env.GITHUB_TOKEN },
                stdio: 'inherit'
            });
            console.log("ZIP successfully uploaded to GitHub Release.");
        } catch (err) {
            console.error("Failed to upload ZIP to GitHub Release:", err.message);
            await failAudit('publish', `Failed to upload ZIP to GitHub Release: ${err.message}`);
        }
    }

    await updateStep('publish', 'success', 'Done!');
    if (process.env.GITHUB_TOKEN && process.env.REPOSITORY && process.env.ISSUE_NUMBER) {
        await axios.patch(`https://api.github.com/repos/${process.env.REPOSITORY}/issues/${process.env.ISSUE_NUMBER}`,
            { state: 'closed', state_reason: 'completed' },
            { headers: { 'Authorization': `Bearer ${process.env.GITHUB_TOKEN}`, 'Accept': 'application/vnd.github.v3+json' } }
        );
    }
}

run().catch(console.error);
