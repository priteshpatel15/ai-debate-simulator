#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

console.log('🎙️ AI Debate Simulator Setup\n');
console.log('This script will help you configure your OpenAI API key.\n');

// Check if .env already exists
const envPath = path.join(__dirname, 'server', '.env');
if (fs.existsSync(envPath)) {
  console.log('✅ .env file already exists at server/.env');
  console.log('If you need to update your API key, edit the file directly.\n');
  rl.close();
  process.exit(0);
}

rl.question('Please enter your OpenAI API key: ', (apiKey) => {
  if (!apiKey || apiKey.trim() === '') {
    console.log('❌ No API key provided. Please run the setup again.');
    rl.close();
    process.exit(1);
  }

  // Create .env file content
  const envContent = `# OpenAI API Configuration
OPENAI_API_KEY=${apiKey.trim()}

# Server Configuration
PORT=3001
`;

  // Write the .env file
  try {
    fs.writeFileSync(envPath, envContent);
    console.log('✅ .env file created successfully at server/.env');
    console.log('\n🚀 You can now run the application with: npm run dev');
    console.log('\nIMPORTANT: Keep your API key secure and never share it publicly!');
  } catch (error) {
    console.error('❌ Error creating .env file:', error.message);
    console.log('\n📝 Please create the file manually:');
    console.log('1. Create a file named ".env" in the server/ directory');
    console.log('2. Add this content:');
    console.log(envContent);
  }

  rl.close();
}); 