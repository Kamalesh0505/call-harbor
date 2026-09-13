const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({ dest: path.join(__dirname, 'uploads') });

// In-memory storage for parsed CSV contacts
let contactList = [];
const agentAccounts = new Map();
const activeSessions = new Map();

const accountsFile = path.join(__dirname, 'agent-accounts.json');
if (fs.existsSync(accountsFile)) {
    JSON.parse(fs.readFileSync(accountsFile, 'utf8')).forEach(account => agentAccounts.set(account.loginId, account));
}

function saveAgentAccounts() {
    fs.writeFileSync(accountsFile, JSON.stringify([...agentAccounts.values()], null, 2));
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const hash = crypto.scryptSync(password, salt, 64).toString('hex');
    return { salt, hash };
}

function getAgentSession(req) {
    const authorization = req.headers.authorization || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    for (const [loginId, sessionToken] of activeSessions) {
        if (sessionToken === token) return { loginId, token };
    }
    return null;
}

// 1. Upload CSV Route
app.post('/upload-csv', upload.single('file'), (req, res) => {
    const results = [];
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    fs.createReadStream(req.file.path)
        .pipe(csv())
        .on('data', (data) => {
            const normalized = Object.fromEntries(
                Object.entries(data).map(([key, value]) => [key.trim().toLowerCase().replace(/[_-]+/g, ' '), value?.trim() || ''])
            );
            const getValue = (...keys) => keys.map(key => normalized[key]).find(value => value) || '';
            const loanNumber = getValue('loan number', 'loannumber');
            const name = getValue('customer name', 'name') || 'Unknown';
            const phone = getValue('mobile number', 'phone', 'number');
            const pos = getValue('pos');
            const emi = getValue('emi');
            const tenure = getValue('tenure');
            const teleCaller = getValue('tele caller name', 'telecaller', 'tele caller');
            const bucket = getValue('bucket');
            const address = getValue('address');
            const lmpd = getValue('lmpd');

            if (phone) {
                results.push({
                    loanNumber, name, phone, pos, emi, tenure,
                    teleCaller, bucket, address, lmpd,
                    status: 'Pending',
                    remarks: '',
                    recordingUrl: '', // New Feature: Store actual recording URL
                    duration: '00:00' // New Feature: Store call duration
                });
            }
        })
        .on('end', () => {
            contactList = contactList.concat(results);
            fs.unlinkSync(req.file.path);
            res.json({ message: 'CSV uploaded successfully', total: contactList.length });
        });
});

// 2. Get Contacts List
app.get('/contacts', (req, res) => {
    res.json(contactList);
});

// Admin-managed agent login accounts. Passwords are never returned to the client.
app.post('/agent-accounts', (req, res) => {
    const { loginId, password, agentId, agentName } = req.body;
    if (!loginId || !password || !agentId || !agentName) {
        return res.status(400).json({ error: 'Login ID, password, agent ID, and agent name are required.' });
    }
    if (String(password).length < 6) {
        return res.status(400).json({ error: 'Password must contain at least 6 characters.' });
    }
    const normalizedLoginId = String(loginId).trim().toLowerCase();
    if (agentAccounts.has(normalizedLoginId)) {
        return res.status(409).json({ error: 'That login ID already exists.' });
    }
    agentAccounts.set(normalizedLoginId, {
        loginId: normalizedLoginId,
        agentId: String(agentId).trim(),
        agentName: String(agentName).trim(),
        ...hashPassword(String(password))
    });
    saveAgentAccounts();
    res.status(201).json({ loginId: normalizedLoginId, agentId, agentName });
});

app.get('/agent-accounts', (req, res) => {
    res.json([...agentAccounts.values()].map(({ loginId, agentId, agentName }) => ({ loginId, agentId, agentName })));
});

app.post('/agent-login', (req, res) => {
    const { loginId, password } = req.body;
    const account = agentAccounts.get(String(loginId || '').trim().toLowerCase());
    if (!account || !password) return res.status(401).json({ error: 'Invalid login ID or password.' });
    const attemptedHash = crypto.scryptSync(String(password), account.salt, 64).toString('hex');
    if (attemptedHash !== account.hash) return res.status(401).json({ error: 'Invalid login ID or password.' });
    const sessionToken = crypto.randomBytes(32).toString('hex');
    activeSessions.set(account.loginId, sessionToken);
    res.json({ success: true, sessionToken, agentId: account.agentId, agentName: account.agentName });
});

app.get('/agent-session', (req, res) => {
    const session = getAgentSession(req);
    if (!session) return res.status(401).json({ error: 'This agent account is signed in on another device.' });
    const account = agentAccounts.get(session.loginId);
    res.json({ success: true, agentId: account.agentId, agentName: account.agentName });
});

app.post('/start-call', async (req, res) => {
    const { phone } = req.body;
    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const callerId = process.env.TWILIO_PHONE_NUMBER;
    const agentPhone = process.env.TWILIO_AGENT_PHONE_NUMBER;

    if (!accountSid || !authToken || !callerId || !agentPhone) {
        return res.status(503).json({ error: 'Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER, and TWILIO_AGENT_PHONE_NUMBER.' });
    }
    if (!phone || !/^\+[1-9]\d{7,14}$/.test(phone)) {
        return res.status(400).json({ error: 'Customer phone must use international format, for example +919876543210.' });
    }

    try {
        const client = twilio(accountSid, authToken);
        const call = await client.calls.create({
            to: agentPhone,
            from: callerId,
            twiml: `<Response><Say voice="alice">Connecting your CallHarbor call.</Say><Dial callerId="${callerId}"><Number>${phone}</Number></Dial></Response>`
        });
        res.json({ success: true, callSid: call.sid, status: call.status });
    } catch (error) {
        console.error('Twilio call failed:', error.message);
        res.status(502).json({ error: 'Twilio could not start the call. Check your credentials, caller ID, and destination number.' });
    }
});

// 3. Mark Contact as Called & Save Recording/Duration
app.post('/mark-called', (req, res) => {
    const { phone, duration, recordingUrl } = req.body;
    const contact = contactList.find(c => c.phone === phone);
    if (contact) {
        contact.status = 'Called';
        contact.duration = duration || '00:00';
        contact.recordingUrl = recordingUrl || '';
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Contact not found' });
    }
});

// 4. Save Remarks Endpoint
app.post('/update-remark', (req, res) => {
    const { phone, remark } = req.body;
    const contact = contactList.find(c => c.phone === phone);
    if (contact) {
        contact.remarks = remark;
        res.json({ success: true, message: 'Remark saved' });
    } else {
        res.status(404).json({ error: 'Contact not found' });
    }
});

// 5. Clear Contacts List
app.delete('/clear-contacts', (req, res) => {
    contactList = [];
    res.json({ success: true, message: 'All contacts cleared.' });
});

// 6. Telephony TwiML Endpoint
app.post('/voice', (req, res) => {
    const toNumber = req.body.To;
    const companyNumber = process.env.COMPANY_PHONE_NUMBER || "+1234567890";

    res.type('text/xml');
    res.send(`
        <Response>
            <Dial callerId="${companyNumber}" record="record-from-answer-dual">
                <Number>${toNumber}</Number>
            </Dial>
        </Response>
    `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
