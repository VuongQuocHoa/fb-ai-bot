const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- BỘ LƯU TRỮ CẤU HÌNH VẬN HÀNH THỰC TẾ (IN-MEMORY / PRODUCTION CONFIG) ---
let config = {
    pageAccessToken: process.env.PAGE_ACCESS_TOKEN || '',
    verifyToken: process.env.VERIFY_TOKEN || 'my_secure_verify_token_123',
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    systemPrompt: `Bạn là trợ lý chăm sóc khách hàng AI chuyên nghiệp trên Fanpage.
Nhiệm vụ của bạn:
1. Chào hỏi lịch sự, tư vấn sản phẩm/dịch vụ chính xác.
2. Trả lời câu hỏi ngắn gọn, rõ ràng, dễ hiểu.
3. Thu thập thông tin tên và số điện thoại nếu khách hàng muốn đặt hàng hoặc cần tư vấn sâu.`,
    modelName: 'gemini-1.5-flash'
};

// Lưu trữ Logs giao dịch thực tế từ Messenger
let liveLogs = [];

function addLog(type, senderId, message, status) {
    const logEntry = {
        id: Date.now(),
        timestamp: new Date().toISOString(),
        type,
        senderId,
        message,
        status
    };
    liveLogs.unshift(logEntry);
    if (liveLogs.length > 100) liveLogs.pop(); // Giữ tối đa 100 log gần nhất
}

// ==========================================
// 1. API ROUTES DÀNH CHO DASHBOARD CẤU HÌNH
// ==========================================

app.get('/api/config', (req, res) => {
    res.json({
        pageAccessTokenConfigured: !!config.pageAccessToken,
        verifyToken: config.verifyToken,
        geminiApiKeyConfigured: !!config.geminiApiKey,
        systemPrompt: config.systemPrompt,
        modelName: config.modelName
    });
});

app.post('/api/config', (req, res) => {
    const { pageAccessToken, verifyToken, geminiApiKey, systemPrompt, modelName } = req.body;
    if (pageAccessToken !== undefined) config.pageAccessToken = pageAccessToken.trim();
    if (verifyToken !== undefined) config.verifyToken = verifyToken.trim();
    if (geminiApiKey !== undefined) config.geminiApiKey = geminiApiKey.trim();
    if (systemPrompt !== undefined) config.systemPrompt = systemPrompt.trim();
    if (modelName !== undefined) config.modelName = modelName;

    res.json({ success: true, message: 'Đã cập nhật cấu hình hệ thống thành công!' });
});

app.get('/api/logs', (req, res) => {
    res.json(liveLogs);
});

// ==========================================
// 2. WEBHOOK THỰC TẾ DÀNH CHO FACEBOOK MESSENGER
// ==========================================

// Endpoint xác minh Webhook từ Meta Developer Console
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === config.verifyToken) {
            console.log('[WEBHOOK_VERIFIED] Kết nối Webhook Facebook thành công!');
            return res.status(200).send(challenge);
        } else {
            console.error('[WEBHOOK_ERROR] Verify Token không khớp.');
            return res.sendStatus(403);
        }
    }
    res.sendStatus(400);
});

// Endpoint tiếp nhận tin nhắn thực từ Messenger
app.post('/webhook', async (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        // Phải trả về 200 OK ngay lập tức cho Facebook theo chuẩn SDK Meta
        res.status(200).send('EVENT_RECEIVED');

        for (const entry of body.entry) {
            if (!entry.messaging) continue;

            for (const webhookEvent of entry.messaging) {
                const senderPsid = webhookEvent.sender ? webhookEvent.sender.id : null;

                if (webhookEvent.message && webhookEvent.message.text && senderPsid) {
                    const userText = webhookEvent.message.text;
                    console.log(`[INCOMING_MSG] Từ PSID ${senderPsid}: "${userText}"`);
                    addLog('INCOMING', senderPsid, userText, 'Received');

                    // Xử lý và phản hồi tin nhắn tự động bằng AI
                    await processAndReplyMessage(senderPsid, userText);
                }
            }
        }
    } else {
        res.sendStatus(404);
    }
});

// Hàm gọi Gemini API thật & gửi tin nhắn lại cho người dùng qua Facebook Graph API
async function processAndReplyMessage(senderPsid, userText) {
    if (!config.geminiApiKey) {
        console.error('[AI_ERROR] Chưa cấu hình Gemini API Key.');
        addLog('SYSTEM_ERROR', senderPsid, 'Chưa cấu hình Gemini API Key.', 'Failed');
        return;
    }

    if (!config.pageAccessToken) {
        console.error('[FB_ERROR] Chưa cấu hình Facebook Page Access Token.');
        addLog('SYSTEM_ERROR', senderPsid, 'Chưa cấu hình Facebook Page Access Token.', 'Failed');
        return;
    }

    try {
        // 1. Gọi Gemini API thực tế
        const geminiEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${config.modelName}:generateContent?key=${config.geminiApiKey}`;

        const promptPayload = {
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: `${config.systemPrompt}\n\n[Khách hàng nhắn]: ${userText}` }
                    ]
                }
            ]
        };

        const aiRes = await axios.post(geminiEndpoint, promptPayload, {
            headers: { 'Content-Type': 'application/json' }
        });

        const aiReplyText = aiRes.data?.candidates?.[0]?.content?.parts?.[0]?.text;

        if (!aiReplyText) {
            throw new Error('Không nhận được văn bản phản hồi từ Gemini API');
        }

        // 2. Gửi phản hồi thực tế về Facebook Messenger người dùng qua Graph API
        const fbGraphEndpoint = `https://graph.facebook.com/v18.0/me/messages?access_token=${config.pageAccessToken}`;

        await axios.post(fbGraphEndpoint, {
            recipient: { id: senderPsid },
            message: { text: aiReplyText }
        });

        console.log(`[OUTGOING_MSG] Đã gửi phản hồi thành công cho PSID ${senderPsid}`);
        addLog('OUTGOING', senderPsid, aiReplyText, 'Sent');

    } catch (error) {
        const errorDetails = error.response ? JSON.stringify(error.response.data) : error.message;
        console.error('[PROCESSING_ERROR]', errorDetails);
        addLog('ERROR', senderPsid, `Lỗi xử lý: ${error.message}`, 'Failed');
    }
}

// ==========================================
// 3. FRONTEND DASHBOARD GIAO DIỆN QUẢN TRỊ
// ==========================================

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hệ Thống Triển Khai AI Facebook Messenger (Production)</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
</head>
<body class="bg-slate-100 font-sans text-slate-800">

  <div class="max-w-7xl mx-auto p-4 md:p-6 space-y-6">
    <!-- Header -->
    <header class="bg-white rounded-xl shadow-sm p-5 border border-slate-200 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
      <div>
        <h1 class="text-2xl font-bold text-slate-900 flex items-center gap-2">
          <i class="fa-brands fa-facebook-messenger text-blue-600"></i>
          AI Messenger Production Control Hub
        </h1>
        <p class="text-sm text-slate-500 mt-1">Hệ thống kết nối Webhook thật & Tích hợp Gemini API vận hành 24/7</p>
      </div>
      <div class="flex items-center gap-2">
        <span class="px-3 py-1.5 bg-slate-100 text-slate-700 text-xs font-mono rounded-lg border border-slate-300">
          Webhook URL: <span class="font-bold text-blue-600">/webhook</span>
        </span>
      </div>
    </header>

    <div class="grid grid-cols-1 lg:grid-cols-12 gap-6">
      <!-- Left Column: Settings -->
      <section class="lg:col-span-5 bg-white rounded-xl shadow-sm p-6 border border-slate-200 space-y-4">
        <h2 class="text-lg font-bold text-slate-800 border-b pb-3 flex items-center gap-2">
          <i class="fa-solid fa-gears text-indigo-600"></i> Cấu hình kết nối thực tế
        </h2>

        <form id="configForm" onsubmit="saveConfig(event)" class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">Verify Token (Facebook Webhook)</label>
            <input type="text" id="verifyToken" required class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none">
            <p class="text-[11px] text-slate-500 mt-1">Dùng token này nhập vào Meta Developer Console khi xác minh Webhook.</p>
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">Facebook Page Access Token</label>
            <input type="password" id="pageAccessToken" placeholder="EAAG..." class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none">
            <p class="text-[11px] text-slate-500 mt-1">Token quyền của Fanpage lấy từ Meta for Developers.</p>
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">Google Gemini API Key</label>
            <input type="password" id="geminiApiKey" placeholder="AIzaSy..." class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none">
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">Mô hình AI</label>
            <select id="modelName" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none">
              <option value="gemini-1.5-flash">Gemini 1.5 Flash (Nhanh & Tối ưu chi phí)</option>
              <option value="gemini-1.5-pro">Gemini 1.5 Pro (Chuyên sâu)</option>
            </select>
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-700 uppercase mb-1">Kịch bản chỉ dẫn AI (System Prompt)</label>
            <textarea id="systemPrompt" rows="5" class="w-full p-2.5 bg-slate-50 border border-slate-300 rounded-lg text-xs leading-relaxed focus:ring-2 focus:ring-blue-500 focus:outline-none"></textarea>
          </div>

          <button type="submit" class="w-full py-3 bg-blue-600 hover:bg-blue-700 text-white font-bold text-sm rounded-lg transition flex items-center justify-center gap-2">
            <i class="fa-solid fa-floppy-disk"></i> Lưu cấu hình vận hành
          </button>
        </form>
        <div id="alertBox" class="hidden p-3 rounded-lg text-xs font-medium"></div>
      </section>

      <!-- Right Column: Real-time Webhook Transaction Logs -->
      <section class="lg:col-span-7 bg-white rounded-xl shadow-sm p-6 border border-slate-200 flex flex-col">
        <div class="flex justify-between items-center border-b pb-3 mb-4">
          <h2 class="text-lg font-bold text-slate-800 flex items-center gap-2">
            <i class="fa-solid fa-list-check text-emerald-600"></i> Lịch sử Giao dịch Webhook Real-time
          </h2>
          <button onclick="fetchLogs()" class="text-xs px-3 py-1 bg-slate-100 hover:bg-slate-200 rounded text-slate-600 font-medium transition">
            <i class="fa-solid fa-arrows-rotate mr-1"></i> Làm mới
          </button>
        </div>

        <div class="flex-1 overflow-y-auto max-h-[520px] space-y-3 pr-1" id="logsContainer">
          <p class="text-xs text-slate-400 text-center py-8">Đang tải nhật ký dữ liệu thực...</p>
        </div>
      </section>
    </div>
  </div>

  <script>
    async function loadConfig() {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        document.getElementById('verifyToken').value = data.verifyToken || '';
        document.getElementById('systemPrompt').value = data.systemPrompt || '';
        document.getElementById('modelName').value = data.modelName || 'gemini-1.5-flash';
        
        if (data.pageAccessTokenConfigured) {
          document.getElementById('pageAccessToken').placeholder = '•••••••••••••••••••• (Đã cấu hình)';
        }
        if (data.geminiApiKeyConfigured) {
          document.getElementById('geminiApiKey').placeholder = '•••••••••••••••••••• (Đã cấu hình)';
        }
      } catch (e) {
        console.error('Lỗi tải cấu hình:', e);
      }
    }

    async function saveConfig(e) {
      e.preventDefault();
      const payload = {
        verifyToken: document.getElementById('verifyToken').value,
        systemPrompt: document.getElementById('systemPrompt').value,
        modelName: document.getElementById('modelName').value
      };

      const tokenVal = document.getElementById('pageAccessToken').value;
      if (tokenVal) payload.pageAccessToken = tokenVal;

      const keyVal = document.getElementById('geminiApiKey').value;
      if (keyVal) payload.geminiApiKey = keyVal;

      try {
        const res = await fetch('/api/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await res.json();
        
        const alertBox = document.getElementById('alertBox');
        alertBox.className = 'p-3 rounded-lg text-xs font-medium bg-green-100 text-green-800 block';
        alertBox.innerText = result.message;
        setTimeout(() => alertBox.classList.add('hidden'), 3000);
      } catch (e) {
        alert('Lỗi lưu cấu hình');
      }
    }

    async function fetchLogs() {
      try {
        const res = await fetch('/api/logs');
        const logs = await res.json();
        const container = document.getElementById('logsContainer');

        if (!logs || logs.length === 0) {
          container.innerHTML = '<p class="text-xs text-slate-400 text-center py-12">Chưa có lượt tin nhắn thực tế nào từ Messenger gửi tới Webhook.</p>';
          return;
        }

        container.innerHTML = logs.map(log => {
          const isIncoming = log.type === 'INCOMING';
          const isError = log.type.includes('ERROR');
          
          let badgeClass = 'bg-blue-100 text-blue-700';
          let title = 'Tin nhắn khách hàng';

          if (!isIncoming && !isError) {
            badgeClass = 'bg-emerald-100 text-emerald-700';
            title = 'AI Phản hồi';
          } else if (isError) {
            badgeClass = 'bg-red-100 text-red-700';
            title = 'Lỗi hệ thống';
          }

          return \`
            <div class="p-3 rounded-lg border \${isError ? 'border-red-200 bg-red-50/50' : 'border-slate-200 bg-slate-50'} text-xs space-y-1">
              <div class="flex justify-between items-center">
                <span class="px-2 py-0.5 rounded font-bold \${badgeClass}">\${title}</span>
                <span class="text-[10px] text-slate-400 font-mono">\${new Date(log.timestamp).toLocaleTimeString()}</span>
              </div>
              <div class="text-slate-700 font-medium pt-1">
                <span class="text-slate-400 font-mono">[PSID: \${log.senderId}]:</span> \${escapeHtml(log.message)}
              </div>
            </div>
          \`;
        }).join('');
      } catch (e) {
        console.error('Lỗi tải logs:', e);
      }
    }

    function escapeHtml(str) {
      return (str || '').replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    }

    loadConfig();
    fetchLogs();
    setInterval(fetchLogs, 4000); // Tự động làm mới log thực tế mỗi 4 giây
  </script>
</body>
</html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`====================================================`);
    console.log(`[SERVER RUNNING] Web App & Webhook chạy tại port ${PORT}`);
    console.log(`- Dashboard Cấu hình: http://localhost:${PORT}`);
    console.log(`- Endpoint Webhook Facebook: http://localhost:${PORT}/webhook`);
    console.log(`====================================================`);
});