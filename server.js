// Load environment variables from .env file
require('dotenv').config();

const express = require('express');
const fileUpload = require('express-fileupload');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const AdmZip = require('adm-zip');
const { GoogleGenAI } = require('@google/genai');

// --- INITIALIZATION & CONFIG ---
const app = express();
const PORT = process.env.PORT || 8080;

// Check for Gemini API Key and initialize the AI client
if (!process.env.GEMINI_API_KEY) {
  console.error("FATAL ERROR: GEMINI_API_KEY environment variable not set.");
}
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const geminiModel = 'gemini-2.5-pro';

// Create a temporary directory for file processing
const tempDir = path.join(os.tmpdir(), 'stack-morph-uploads');
if (!fs.existsSync(tempDir)){
    console.log(`Creating temporary directory at ${tempDir}`);
    fs.mkdirSync(tempDir, { recursive: true });
}

// A set of common code file extensions to process
const CODE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.html', '.css', '.scss', '.json', '.md'
]);


// --- MIDDLEWARE ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload());


// --- HELPER FUNCTIONS ---
const getAllFilePaths = (dir) => {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach((file) => {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat && stat.isDirectory()) {
            if (file !== 'node_modules' && file !== '.git') {
                 results = results.concat(getAllFilePaths(filePath));
            }
        } else {
            results.push(filePath);
        }
    });
    return results;
};

/**
 * Parses the AI's structured response and returns an array of { path, content } objects.
 * Expects format:
 * // START_FILE: path/to/file.js
 * ... file content ...
 * // END_FILE: path/to/file.js
 */
// ---
// MODIFICATION: This function is now smarter and removes markdown code fences
// (like ```json ... ```) that the AI might add.
// ---
const parseAIResponse = (responseText) => {
  const files = [];
  const fileRegex = /\/\/ START_FILE: ([\S]+)\n([\s\S]*?)\n\/\/ END_FILE: \1/g;
  let match;

  while ((match = fileRegex.exec(responseText)) !== null) {
    const filePath = match[1];
    let fileContent = match[2]; // Get the content block

    // Regex to find content wrapped in markdown fences (e.g., ```json ... ```)
    // It matches an optional language tag (like 'json')
    // It uses [\s\S]*? to grab the content non-greedily
    const markdownFenceRegex = /^\s*```[a-z]*\n([\s\S]*?)\n```\s*$/;
    const fenceMatch = fileContent.match(markdownFenceRegex);

    if (fenceMatch) {
      // If it matches, the real content is in group 1
      fileContent = fenceMatch[1];
    }

    files.push({ path: filePath, content: fileContent.trim() });
  }
  return files;
};


// --- API ROUTES ---
app.post('/convert', async (req, res) => {
  console.log('[API /convert] Received conversion request.');

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is not configured with a Gemini API key.' });
  }
  if (!req.files || !req.files.sourceCode) {
    return res.status(400).json({ error: 'No .zip file was uploaded under the "sourceCode" field.' });
  }
  if (!req.body.targetStack) {
    return res.status(400).json({ error: 'The "targetStack" field is required.' });
  }

  const projectZip = req.files.sourceCode;
  const { targetStack } = req.body;
  const requestTempDir = path.join(tempDir, `request-${Date.now()}`);

  try {
    // 1. Extract source project
    const extractPath = path.join(requestTempDir, 'source');
    const zip = new AdmZip(projectZip.data);
    zip.extractAllTo(extractPath, /*overwrite*/ true);
    console.log(`[API /convert] Extracted project to: ${extractPath}`);

    // 2. Read all code files into a single context
    const allFiles = getAllFilePaths(extractPath);
    const codeFiles = allFiles.filter(file => CODE_EXTENSIONS.has(path.extname(file)));
    console.log(`[API /convert] Found ${codeFiles.length} code files to process.`);

    const projectContext = [];
    for (const filePath of codeFiles) {
        const content = fs.readFileSync(filePath, 'utf-8');
        const relativePath = path.relative(extractPath, filePath).replace(/\\/g, '/'); // Ensure posix paths
        if (content.trim()) {
            projectContext.push(`File: ${relativePath}\n\`\`\`\n${content}\n\`\`\``);
        }
    }
    const fullProjectCode = projectContext.join('\n\n---\n\n');

    // 3. Create the new "Full Project Context" prompt
    const prompt = `
You are an expert AI software engineer. Your task is to perform a complete migration of the provided source code to a new, runnable project using ${targetStack}.

You will be given the complete source code for a project, with each file clearly demarcated.

**Your goal is to output a complete, runnable ${targetStack} project, not just a 1-to-1 file conversion.**

**MANDATORY INSTRUCTIONS:**

1.  **Convert Logic:** Convert all source files to be idiomatic for ${targetStack}, preserving all logic and functionality.
2.  **Create Folder Structure:** Organize all converted files into a standard, professional folder structure for a modern ${targetStack} project (e.g., for Vue/React, use a 'src' directory with 'components', 'assets', etc.).
3.  **Generate 'package.json':** Create a new 'package.json' file. It must include:
    * The correct main dependency (e.g., "react", "vue", "svelte").
    * The necessary build tools as 'devDependencies' (e.g., "vite" and its plugins).
    * Script commands for "dev" and "build".
4.  **Generate Build Config:** Create any necessary build configuration files (e.g., 'vite.config.js').
5.  **Generate 'index.html':** Create a new root 'index.html' file to load the new ${targetStack} application.
6.  **Generate 'README.md':** Create a new 'README.md' file that includes:
    * A title for the converted project.
    * Simple setup instructions: 'npm install' and 'npm run dev'.
7.  **Handle Imports:** Ensure all file imports/exports are updated to reflect the new file structure and syntax.

**OUTPUT FORMAT:**
- The output must *only* be the raw code for the new files.
- Do not include *any* explanations or introductory text.
- You *must* format your response as a series of files, using the following exact format for *every* file (including 'package.json', 'README.md', etc.):

// START_FILE: path/to/new/file.js
... (all the content for this file) ...
// END_FILE: path/to/new/file.js

---
**ORIGINAL PROJECT SOURCE CODE:**
---
${fullProjectCode}
---
    `;

    // 4. Send the single, massive request to the AI
    console.log(`[API /convert] Sending full project context (${fullProjectCode.length} chars) to Gemini...`);
    
    // Note: This API call will be much slower than before.
    const response = await ai.models.generateContent({
      model: geminiModel,
      contents: prompt
    });

    const aiResponseText = response.text;
    console.log('[API /convert] Received response from Gemini.');

    // 5. Parse the AI's response and create the new zip file
    const convertedFiles = parseAIResponse(aiResponseText);

    if (convertedFiles.length === 0) {
      console.error('[API /convert] AI response was not in the expected format. No files were parsed.');
      return res.status(500).json({ error: 'Conversion failed: The AI returned an unparsable response.' });
    }

    const outputZip = new AdmZip();
    for (const file of convertedFiles) {
        outputZip.addFile(file.path, Buffer.from(file.content, 'utf8'));
    }

    const outputZipBuffer = outputZip.toBuffer();
    console.log(`[API /convert] Re-packaged ${convertedFiles.length} converted files.`);

    // 6. Send the new zip file to the client
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="converted-${projectZip.name}"`);
    res.send(outputZipBuffer);
    console.log('[API /convert] Sent converted .zip file to client.');

  } catch (error) {
    console.error('[API /convert] A critical error occurred during the conversion process:', error);
    res.status(500).json({ error: 'Failed to convert project due to a server error.' });
  } finally {
    if (fs.existsSync(requestTempDir)) {
      fs.rmSync(requestTempDir, { recursive: true, force: true });
      console.log(`[API /convert] Cleaned up temporary directory: ${requestTempDir}`);
    }
  }
});


// --- SERVE FRONTEND ---
// (This section remains unchanged)
const buildPath = path.join(__dirname, 'dist');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
} else {
    console.warn('Frontend build directory "dist" not found. The server will only handle API routes.');
    app.get('/', (req, res) => {
        res.send('Stack Morph backend is running. Run `npm run build` to serve the frontend.');
    });
}

// --- START SERVER ---
app.listen(PORT, () => {
  console.log(`Server is live and listening on port ${PORT}`);
});