const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const si = require('systeminformation');
const os = require('os-utils');
const { spawn } = require('child_process');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;
const PASSWORD = 'yourpassword';
const SETTINGS_FILE = path.join(__dirname, 'settings.json');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

const sessionMiddleware = session({
    secret: 'a_very_strong_and_random_secret_for_session_final',
    resave: false,
    saveUninitialized: true,
    rolling: true,
    cookie: {
        maxAge: 15 * 60 * 1000,
        httpOnly: true,
    }
});
app.use(sessionMiddleware);
io.engine.use(sessionMiddleware);

const checkAuth = (req, res, next) => {
    if (req.session.loggedIn) {
        next();
    } else {
        res.redirect('/login.html');
    }
};
app.get('/', checkAuth, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/login', (req, res) => {
    if (req.body.password === PASSWORD) {
        req.session.regenerate(function (err) {
            if (err) next(err);
            req.session.loggedIn = true;
            req.session.save(function (err) {
                if (err) return next(err);
                res.redirect('/');
            });
        });
    } else {
        res.redirect('/login.html?error=1');
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login.html');
    });
});

let alertState = { cpu: false, ram: false, networkIn: false, networkOut: false };

function loadSettings() {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const data = fs.readFileSync(SETTINGS_FILE, 'utf-8');
            return JSON.parse(data);
        }
    } catch (error) { console.error("Error loading settings:", error); }
    return { webhookUrl: '', cpuThreshold: '90', ramThreshold: '90', netInThreshold: '1000', netInUnit: 'Mbps', netOutThreshold: '1000', netOutUnit: 'Mbps' };
}

function saveSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
    } catch (error) { console.error("Error saving settings:", error); }
}

async function sendWebhook(type, details) {
    const settings = loadSettings();
    if (!settings.webhookUrl || !settings.webhookUrl.startsWith('http')) return;

    const color = type === 'triggered' ? 15158332 : 3066993;
    const title = type === 'triggered' ? `🚨 Alert Triggered: ${details.metric}` : `✅ Alert Resolved: ${details.metric}`;
    const embed = {
        title: title,
        color: color,
        fields: [
            { name: 'Threshold', value: `> ${details.threshold}`, inline: true },
            { name: 'Current Value', value: `> ${details.value}`, inline: true }
        ],
        footer: { text: 'System Dashboard' },
        timestamp: new Date().toISOString()
    };
    try {
        await axios.post(settings.webhookUrl, { embeds: [embed] });
        console.log(`Webhook [${type}] sent for ${details.metric}.`);
    } catch (error) {
        console.error("Webhook sending error:", error.message);
    }
}

function checkAlerts(stats, settings) {
    const s = {
        cpuThreshold: parseFloat(settings.cpuThreshold), ramThreshold: parseFloat(settings.ramThreshold),
        netInThreshold: parseFloat(settings.netInThreshold), netOutThreshold: parseFloat(settings.netOutThreshold)
    };
    if (isNaN(s.cpuThreshold) || isNaN(s.ramThreshold) || isNaN(s.netInThreshold) || isNaN(s.netOutThreshold)) return;

    if (parseFloat(stats.cpu) > s.cpuThreshold && !alertState.cpu) { sendWebhook('triggered', { metric: 'CPU', threshold: `${s.cpuThreshold}%`, value: `${stats.cpu}%` }); alertState.cpu = true; } else if (parseFloat(stats.cpu) < s.cpuThreshold && alertState.cpu) { sendWebhook('resolved', { metric: 'CPU', threshold: `${s.cpuThreshold}%`, value: `${stats.cpu}%` }); alertState.cpu = false; }
    if (parseFloat(stats.mem.percent) > s.ramThreshold && !alertState.ram) { sendWebhook('triggered', { metric: 'RAM', threshold: `${s.ramThreshold}%`, value: `${stats.mem.percent}%` }); alertState.ram = true; } else if (parseFloat(stats.mem.percent) < s.ramThreshold && alertState.ram) { sendWebhook('resolved', { metric: 'RAM', threshold: `${s.ramThreshold}%`, value: `${stats.mem.percent}%` }); alertState.ram = false; }
    
    const toKbps = (v, u) => { if (u === 'Gbps') return v * 1000 * 1000; if (u === 'Mbps') return v * 1000; return v; };
    const netInKbps = parseFloat(stats.network.mbps_in) * 1000;
    const netOutKbps = parseFloat(stats.network.mbps_out) * 1000;
    const thresholdInKbps = toKbps(s.netInThreshold, settings.netInUnit);
    const thresholdOutKbps = toKbps(s.netOutThreshold, settings.netOutUnit);

    if (netInKbps > thresholdInKbps && !alertState.networkIn) { sendWebhook('triggered', { metric: 'Network In', threshold: `${s.netInThreshold} ${settings.netInUnit}`, value: `${stats.network.mbps_in} Mbps` }); alertState.networkIn = true; } else if (netInKbps < thresholdInKbps && alertState.networkIn) { sendWebhook('resolved', { metric: 'Network In', threshold: `${s.netInThreshold} ${settings.netInUnit}`, value: `${stats.network.mbps_in} Mbps` }); alertState.networkIn = false; }
    if (netOutKbps > thresholdOutKbps && !alertState.networkOut) { sendWebhook('triggered', { metric: 'Network Out', threshold: `${s.netOutThreshold} ${settings.netOutUnit}`, value: `${stats.network.mbps_out} Mbps` }); alertState.networkOut = true; } else if (netOutKbps < thresholdOutKbps && alertState.networkOut) { sendWebhook('resolved', { metric: 'Network Out', threshold: `${s.netOutThreshold} ${settings.netOutUnit}`, value: `${stats.network.mbps_out} Mbps` }); alertState.networkOut = false; }
}

let packetCounter = 0;
let tcpdumpProcessTotal;

async function startPacketSniffer() {
    console.log("Starting packet sniffer with tcpdump...");
    const interfaces = await si.networkInterfaces();
    const primaryInterface = interfaces.find(i => i.default)?.iface || 'eth0';
    console.log(`Primary network interface detected: ${primaryInterface}`);

    const argsTotal = ['-l', '-n', '-i', primaryInterface];
    tcpdumpProcessTotal = spawn('tcpdump', argsTotal);
    tcpdumpProcessTotal.stdout.on('data', (data) => {
        packetCounter += (data.toString().match(/\n/g) || []).length;
    });
    tcpdumpProcessTotal.stderr.on('data', (data) => console.error(`tcpdump stderr: ${data}`));
    tcpdumpProcessTotal.on('close', (code) => console.warn(`tcpdump process exited with code ${code}.`));
}

startPacketSniffer().catch(err => {
    console.error("Failed to start tcpdump. Is it installed and do you have sudo permissions?", err);
    process.exit(1);
});

const getCpuUsage = () => new Promise(resolve => os.cpuUsage(usage => resolve(usage)));

io.on('connection', async (socket) => {
    if (!socket.request.session.loggedIn) {
        console.log("WebSocket connection attempt with an invalid/expired session. Disconnecting.");
        socket.disconnect(true);
        return;
    }
    console.log('Client connected to dashboard.');

    let isFirstRun = true;
    let lastNetStats = {};
    let lastPpsStats = {};
    let lastDiskStats = {};

    socket.on('get-settings', () => {
        socket.emit('settings-data', loadSettings());
    });
    socket.on('save-settings', (newSettings) => {
        saveSettings(newSettings);
        socket.emit('settings-saved', { success: true });
        console.log("Settings saved:", newSettings);
    });

    try {
        const cpuInfo = await si.cpu();
        const osInfo = await si.osInfo();
        socket.emit('static-data', { cpu: `${cpuInfo.manufacturer} ${cpuInfo.brand}`, hostname: osInfo.hostname });
    } catch(e) { console.error("Static system info error: ", e); }

    const dataInterval = setInterval(async () => {
        try {
            const now = Date.now();
            const settings = loadSettings();
            const [memData, networkData, diskIoData, fsData, cpuUsage] = await Promise.all([si.mem(), si.networkStats(), si.disksIO(), si.fsSize(), getCpuUsage()]);
            
            const net = networkData[0] || {};
            const rootFs = fsData.find(f => f.mount === '/') || {};
            let stats;

            if (isFirstRun) {
                lastNetStats = { time: now, rx_bytes: (net.rx_bytes || 0), tx_bytes: (net.tx_bytes || 0) };
                lastPpsStats = { time: now, packets: packetCounter };
                lastDiskStats = { time: now, rIO: (diskIoData.rIO || 0), wIO: (diskIoData.wIO || 0) };
                isFirstRun = false;

                stats = {
                    cpu: (cpuUsage * 100).toFixed(2),
                    mem: { total: ((memData.total || 0) / 1024**3).toFixed(2), used: ((memData.active || 0) / 1024**3).toFixed(2), percent: (memData.total || 0) > 0 ? ((memData.active / memData.total) * 100).toFixed(2) : "0.00" },
                    network: { iface: net.iface || 'N/A', mbps_in: '0.00', mbps_out: '0.00', pps_total: '0' },
                    disk: { rps: '0', wps: '0', size_gb: ((rootFs.size || 0) / 1024**3).toFixed(2), used_gb: ((rootFs.used || 0) / 1024**3).toFixed(2), use_percent: (rootFs.use || 0).toFixed(1) }
                };
            } else {
                const netTimeDelta = (now - lastNetStats.time) / 1000;
                const rx_sec = netTimeDelta > 0 ? Math.max(0, ((net.rx_bytes || 0) - lastNetStats.rx_bytes)) / netTimeDelta : 0;
                const tx_sec = netTimeDelta > 0 ? Math.max(0, ((net.tx_bytes || 0) - lastNetStats.tx_bytes)) / netTimeDelta : 0;
                lastNetStats = { time: now, rx_bytes: (net.rx_bytes || 0), tx_bytes: (net.tx_bytes || 0) };

                const ppsTimeDelta = (now - lastPpsStats.time) / 1000;
                const pps = ppsTimeDelta > 0 ? (packetCounter - lastPpsStats.packets) / ppsTimeDelta : 0;
                lastPpsStats = { time: now, packets: packetCounter };

                const diskTimeDelta = (now - lastDiskStats.time) / 1000;
                const rps = diskTimeDelta > 0 ? Math.max(0, ((diskIoData.rIO || 0) - lastDiskStats.rIO)) / diskTimeDelta : 0;
                const wps = diskTimeDelta > 0 ? Math.max(0, ((diskIoData.wIO || 0) - lastDiskStats.wIO)) / diskTimeDelta : 0;
                lastDiskStats = { time: now, rIO: (diskIoData.rIO || 0), wIO: (diskIoData.wIO || 0) };

                stats = {
                    cpu: (cpuUsage * 100).toFixed(2),
                    mem: { total: ((memData.total || 0) / 1024**3).toFixed(2), used: ((memData.active || 0) / 1024**3).toFixed(2), percent: (memData.total || 0) > 0 ? ((memData.active / memData.total) * 100).toFixed(2) : "0.00" },
                    network: { iface: net.iface || 'N/A', mbps_in: (rx_sec * 8 / 1e6).toFixed(2), mbps_out: (tx_sec * 8 / 1e6).toFixed(2), pps_total: pps.toFixed(0) },
                    disk: { rps: (Number(rps) || 0).toFixed(0), wps: (Number(wps) || 0).toFixed(0), size_gb: ((rootFs.size || 0) / 1024**3).toFixed(2), used_gb: ((rootFs.used || 0) / 1024**3).toFixed(2), use_percent: (rootFs.use || 0).toFixed(1) }
                };
            }
            
            socket.emit('dynamic-data', stats);
            checkAlerts(stats, settings);
        } catch (e) { console.error("Critical error in data loop: ", e); }
    }, 2000);

    socket.on('disconnect', () => {
        console.log('Client disconnected.');
        clearInterval(dataInterval);
    });
});

process.on('exit', () => {
    console.log("Shutting down tcpdump process...");
    if (tcpdumpProcessTotal) tcpdumpProcessTotal.kill();
});

server.listen(PORT, () => {
    console.log(`System dashboard running on http://localhost:${PORT}`);
    console.log("Reminder: Script may require sudo privileges for tcpdump.");
});