const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const AdmZip = require('adm-zip');

// --- CONFIGURATION ---
// IMPORTANT: Replace this with your actual Cloud Run service URL (e.g., https://my-service-name-abcdef-uw.a.run.app)
// OR use http://localhost:8080 for local testing
const CLOUD_RUN_BASE_URL = 'https://copy-of-stack-morph-backend-402409256703.us-west1.run.app';
const API_ENDPOINT = `${CLOUD_RUN_BASE_URL}/convert`;
const TARGET_STACK = 'Vue';
const OUTPUT_FILE_NAME = 'converted_result.zip';

/**
 * Creates a dummy zip file in memory for testing purposes.
 * @returns {Buffer} A buffer containing the zip file data.
 */
const createTestZip = () => {
  console.log('Creating a temporary test.zip file in memory...');
  const zip = new AdmZip();

  const reactComponentContent = `
import React, { useState } from 'react';

function MyCounter() {
  const [count, setCount] = useState(0);

  return (
    <div>
      <p>You clicked {count} times</p>
      <button onClick={() => setCount(count + 1)}>
        Click me
      </button>
    </div>
  );
}

export default MyCounter;
`;
  // Add a file to the zip
  zip.addFile('src/MyCounter.js', Buffer.from(reactComponentContent, 'utf8'));

  // Return the zip file as a buffer
  return zip.toBuffer();
};

/**
 * Main function to run the API test.
 */
const runTest = async () => {
  if (CLOUD_RUN_BASE_URL.includes('xxxxxxxxxx')) {
    console.error('\nERROR: Please replace the placeholder CLOUD_RUN_BASE_URL in the script with your actual service URL.');
    return;
  }

  console.log(`\nSending request to: ${API_ENDPOINT}`);
  console.log(`Target framework: ${TARGET_STACK}`);

  const testZipBuffer = createTestZip();
  const form = new FormData();

  // The field name 'sourceCode' MUST match the name in server.js (req.files.sourceCode)
  // and popup.js (formData.append('sourceCode', ...))
  form.append('sourceCode', testZipBuffer, { filename: 'test-project.zip' });
  form.append('targetStack', TARGET_STACK);

  try {
    const response = await axios.post(API_ENDPOINT, form, {
      headers: {
        ...form.getHeaders(),
      },
      responseType: 'arraybuffer', // Important to handle the binary zip data
    });

    // --- VERIFICATION ---
    if (response.status === 200 && response.headers['content-type'] === 'application/zip') {
      console.log('\n✅ SUCCESS: Received a 200 OK response with content-type "application/zip".');
      
      // Save the received zip file to disk for inspection
      fs.writeFileSync(OUTPUT_FILE_NAME, response.data);
      console.log(`✅ The converted project has been saved as "${OUTPUT_FILE_NAME}".`);

    } else {
      console.error(`\n❌ ERROR: Received an unexpected response.`);
      console.error(`- Status: ${response.status}`);
      console.error(`- Content-Type: ${response.headers['content-type']}`);
    }

  } catch (error) {
    console.error('\n❌ ERROR: The API request failed.');
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      console.error(`- Status Code: ${error.response.status}`);
      // The response data for an error is likely text or json
      let responseData = 'Could not parse error response.';
      try {
        // Try parsing as JSON first
        responseData = JSON.parse(Buffer.from(error.response.data).toString('utf8'));
      } catch (e) {
        // Fallback to plain text
        responseData = Buffer.from(error.response.data).toString('utf8');
      }
      console.error('- Response Body:', responseData);
    } else if (error.request) {
      // The request was made but no response was received
      console.error('- No response was received from the server.', error.request);
    } else {
      // Something happened in setting up the request that triggered an Error
      console.error('- Error message:', error.message);
    }
    console.error('\nTroubleshooting tips:');
    console.error('1. Is the server running? (`npm start`)');
    console.error('2. Double-check your CLOUD_RUN_BASE_URL in this script.');
    console.error('3. Check the server logs for any runtime errors.');
  }
};

runTest();
