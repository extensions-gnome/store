# 🛡️ GNOME Beta Store (Storage & Bot)

This repository serves as the **backend and database** for the [GNOME Beta Store](https://extensions-gnome.github.io). It manages the automated auditing pipeline and stores the extension assets.

## 🌟 Mission Statement

The **GNOME Beta Store** is a community-driven, unofficial initiative. It was created with a positive intent: **to help the GNOME ecosystem grow** by providing a fast-track alternative to the official extensions repository. 

We recognize that the official review process is often overwhelmed by the high volume of submissions. Our goal is not to replace the official store, but to provide a secure, automated "beta" channel where developers can publish updates and new features instantly.

## 🛡️ Security & Transparency

We take security seriously. Every extension published here undergoes:
1.  **AI Logic Audit:** Powered by Llama-3, checking for GJS best practices and obvious security flaws.
2.  **Malware Analysis:** Full scan via **VirusTotal** (polling 70+ antivirus engines).
3.  **Ownership Verification:** Strict GitHub-based authorization to prevent unauthorized updates.

**Note:** This is an unofficial project. We are not affiliated with the GNOME Foundation.

## 🚀 How to Publish

Publishing is handled entirely via **GitHub Issues**. [Open a new request here](https://github.com/extensions-gnome/store/issues/new/choose).

Available workflows:
*   **New Extension:** Register your UUID and first version.
*   **Update ZIP:** Quick upload for new versions.
*   **Edit Metadata:** Change descriptions or icons without a new code audit.
*   **Delete Extension:** Request removal (Owner or Admin only).

## 🛠️ Tech Stack
*   **Bot:** Node.js script (`audit.js`) running on GitHub Actions.
*   **AI:** Groq (Llama 3.3 70B).
*   **Security:** VirusTotal API v3.
*   **Database:** `extensions.json`.

---
*Built with ❤️ for the GNOME Community.*
