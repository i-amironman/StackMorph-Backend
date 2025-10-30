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

const parseCodeFromResponse = (text) => {
    const codeBlockRegex = /```(?:\w+\n)?([\s\S]+)```/;
    const match = text.match(codeBlockRegex);
    return match && match[1] ? match[1].trim() : text.trim();
};


// --- API ROUTES ---
// All API routes should be defined here, before the frontend serving logic.

app.post('/convert', async (req, res) => {
  console.log('[API /convert] Received conversion request.');

  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: 'Server is not configured with a Gemini API key.' });
  }
  if (!req.files || !req.files.projectZip) {
    return res.status(400).json({ error: 'No .zip file was uploaded under the "projectZip" field.' });
  }
  if (!req.body.targetStack) {
    return res.status(400).json({ error: 'The "targetStack" field is required.' });
  }

  const projectZip = req.files.projectZip;
  const { targetStack } = req.body;
  
  if (projectZip.mimetype !== 'application/zip' && projectZip.mimetype !== 'application/x-zip-compressed') {
    return res.status(400).json({ error: `Invalid file type: ${projectZip.mimetype}. Please upload a .zip file.` });
  }

  const requestTempDir = path.join(tempDir, `request-${Date.now()}`);

  try {
    const extractPath = path.join(requestTempDir, 'source');
    const zip = new AdmZip(projectZip.data);
    zip.extractAllTo(extractPath, /*overwrite*/ true);
    console.log(`[API /convert] Extracted project to: ${extractPath}`);

    const allFiles = getAllFilePaths(extractPath);
    const codeFiles = allFiles.filter(file => CODE_EXTENSIONS.has(path.extname(file)));
    console.log(`[API /convert] Found ${codeFiles.length} code files to process.`);
    
    for (const filePath of codeFiles) {
        const originalContent = fs.readFileSync(filePath, 'utf-8');
        if (!originalContent.trim()) continue;

        const prompt = `You are an expert programmer specializing in frontend framework migration. Convert the following code snippet to ${targetStack}.
        - Preserve the original logic, functionality, and file structure.
        - Use modern best practices and idiomatic code for ${targetStack}.
        - Ensure the converted code is fully functional and equivalent to the original.
        - The output must be ONLY the raw code for the new file, without any explanations, introductions, or markdown code blocks.
        
        Original file content (${path.basename(filePath)}):
        ---
        ${originalContent}
        ---
        
        Converted ${targetStack} code:`;

        try {
            console.log(`[API /convert] Converting file: ${path.relative(extractPath, filePath)}`);
            const response = await ai.models.generateContent({
              model: geminiModel,
              contents: prompt
            });
            const convertedCode = parseCodeFromResponse(response.text);
            fs.writeFileSync(filePath, convertedCode, 'utf-8');
        } catch (error) {
            console.error(`[API /convert] Gemini API failed for file ${filePath}. Error: ${error.message}. Keeping original content.`);
        }
    }
    
    const outputZip = new AdmZip();
    outputZip.addLocalFolder(extractPath);
    const outputZipBuffer = outputZip.toBuffer();
    console.log('[API /convert] Re-packaged converted project.');

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
// This section must come AFTER all API routes.
const buildPath = path.join(__dirname, 'dist');
if (fs.existsSync(buildPath)) {
  // Serve static files from the 'dist' directory
  app.use(express.static(buildPath));
  
  // The 'catchall' handler for a single-page-application (SPA).
  // It sends index.html for any GET request that doesn't match a static file.
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

