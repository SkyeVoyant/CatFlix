const path = require('path');
const { spawn } = require('child_process');

async function translateTexts({ texts, sourceLanguage, targetLanguage }) {
  if (!Array.isArray(texts) || texts.length === 0) {
    return texts || [];
  }
  if (!sourceLanguage || sourceLanguage === targetLanguage) {
    return texts;
  }

  const scriptPath = path.join(__dirname, 'translator.py');
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [scriptPath, '--source', sourceLanguage, '--target', targetLanguage], {
      stdio: ['pipe', 'pipe', 'inherit']
    });

    const chunks = [];
    proc.stdout.on('data', (data) => chunks.push(data));
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`translator exited with code ${code}`));
      }
      try {
        const output = Buffer.concat(chunks).toString('utf-8');
        const translated = JSON.parse(output);
        resolve(translated);
      } catch (error) {
        reject(error);
      }
    });

    proc.stdin.write(JSON.stringify(texts));
    proc.stdin.end();
  });
}

module.exports = {
  translateTexts
};

