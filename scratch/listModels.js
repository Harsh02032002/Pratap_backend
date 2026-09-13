require('dotenv').config();
const axios = require('axios');

async function main() {
    const key = process.env.GROQ_API_KEY || process.env.AI_MODERATION_API_KEY;
    console.log('Testing Groq Key:', key ? `${key.substring(0, 8)}...` : 'MISSING');
    
    try {
        const res = await axios.get('https://api.groq.com/openai/v1/models', {
            headers: { Authorization: `Bearer ${key}` }
        });
        console.log('\n--- ACTIVE GROQ MODELS ---');
        const models = res.data.data.map(m => m.id).sort();
        models.forEach(m => console.log(' - ' + m));
    } catch (err) {
        console.error('Error fetching models:', err.response ? err.response.data : err.message);
    }
}

main();
