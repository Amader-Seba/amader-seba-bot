// ==================== কনফিগ ====================
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { google } = require('googleapis');

const app = express();
app.use(express.json());

// ==================== ভেরিয়েবল ====================
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const SHEET_ID = process.env.GOOGLE_SHEET_ID;
const ADMIN_PHONE = process.env.ADMIN_PHONE;

// ==================== Google Sheets (ঠিক করা) ====================
const auth = new google.auth.GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

const sheets = google.sheets({ version: 'v4', auth });

// ==================== স্টেট ====================
const userStates = {};
const adminStates = {};

// ==================== ১. সার্ভিস লোড ====================
async function loadServices() {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Services!A:E'
        });
        const rows = response.data.values || [];
        const services = {};
        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (row[0] && row[1]) {
                services[row[0]] = {
                    name: row[1],
                    price: parseInt(row[2]) || 0,
                    deliveryTime: row[3] || 'নতুন অর্ডার',
                    fields: row[4] ? row[4].split(',') : []
                };
            }
        }
        return services;
    } catch (error) {
        console.error('Services লোড ব্যর্থ:', error.message);
        return {};
    }
}

// ==================== ২. অর্ডার সেভ ====================
async function saveOrder(userPhone, serviceId, serviceName, amount, formData) {
    try {
        const orderId = Math.floor(100000 + Math.random() * 900000).toString();
        const now = new Date().toISOString();
        
        await sheets.spreadsheets.values.append({
            spreadsheetId: SHEET_ID,
            range: 'Orders!A:K',
            valueInputOption: 'RAW',
            requestBody: {
                values: [[
                    orderId,
                    userPhone,
                    serviceId,
                    serviceName,
                    amount,
                    JSON.stringify(formData),
                    'pending',
                    '',
                    '',
                    now,
                    ''
                ]]
            }
        });
        return orderId;
    } catch (error) {
        console.error('অর্ডার সেভ ব্যর্থ:', error.message);
        return null;
    }
}

// ==================== ৩. অর্ডার আপডেট ====================
async function updateOrder(orderId, status, deliveryType, deliveryContent, cancelReason = '') {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Orders!A:K'
        });
        const rows = response.data.values || [];
        
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === orderId) {
                rows[i][6] = status;
                if (deliveryType) rows[i][7] = deliveryType;
                if (deliveryContent) rows[i][8] = deliveryContent;
                if (cancelReason) rows[i][10] = cancelReason;
                
                await sheets.spreadsheets.values.update({
                    spreadsheetId: SHEET_ID,
                    range: `Orders!A${i+1}:K${i+1}`,
                    valueInputOption: 'RAW',
                    requestBody: { values: [rows[i]] }
                });
                return true;
            }
        }
        return false;
    } catch (error) {
        console.error('অর্ডার আপডেট ব্যর্থ:', error.message);
        return false;
    }
}

// ==================== ৪. অর্ডার ডিটেইলস ====================
async function getOrderDetails(orderId) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Orders!A:K'
        });
        const rows = response.data.values || [];
        for (let i = 1; i < rows.length; i++) {
            if (rows[i][0] === orderId) {
                return {
                    orderId: rows[i][0],
                    userPhone: rows[i][1],
                    serviceId: rows[i][2],
                    serviceName: rows[i][3],
                    amount: rows[i][4],
                    formData: rows[i][5] ? JSON.parse(rows[i][5]) : {},
                    status: rows[i][6],
                    deliveryType: rows[i][7],
                    deliveryContent: rows[i][8],
                    createdAt: rows[i][9],
                    cancelReason: rows[i][10] || ''
                };
            }
        }
        return null;
    } catch (error) {
        console.error('অর্ডার ডিটেইলস ব্যর্থ:', error.message);
        return null;
    }
}

// ==================== ৫. অ্যাডমিন চেক ====================
async function isAdmin(phone) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Admins!A:A'
        });
        const rows = response.data.values || [];
        return rows.some(row => row[0] === phone);
    } catch (error) {
        return phone === ADMIN_PHONE;
    }
}

// ==================== ৬. WhatsApp মেসেজ পাঠান ====================
async function sendWhatsAppMessage(to, message) {
    try {
        const url = `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`;
        const data = {
            messaging_product: 'whatsapp',
            to: to,
            ...message
        };
        const response = await axios.post(url, data, {
            headers: {
                'Authorization': `Bearer ${WHATSAPP_TOKEN}`,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('WhatsApp মেসেজ ব্যর্থ:', error.response?.data || error.message);
        return null;
    }
}

// ==================== ৭. সার্ভিস মেনু ====================
async function sendServiceMenu(phoneNumber) {
    const services = await loadServices();
    const serviceKeys = Object.keys(services);
    
    if (serviceKeys.length === 0) {
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: '❌ কোনো সার্ভিস পাওয়া যায়নি।' }
        });
        return;
    }
    
    let menuText = '👋 স্বাগতম! আমাদের সার্ভিস সিলেক্ট করুন:\n\n';
    serviceKeys.forEach((key, i) => {
        const s = services[key];
        menuText += `${i+1}. ${s.name} - ${s.price}\n`;
    });
    menuText += `\n📌 সার্ভিসের নামের উপর চাপ দিন।`;
    
    const buttons = serviceKeys.slice(0, 3).map(key => {
        const s = services[key];
        return {
            type: 'reply',
            reply: {
                id: `service_${key}`,
                title: `${s.name} - ${s.price}`
            }
        };
    });
    
    await sendWhatsAppMessage(phoneNumber, {
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: menuText },
            action: { buttons: buttons }
        }
    });
    
    await sendWhatsAppMessage(phoneNumber, {
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: '📋 অন্যান্য অপশন:' },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: { id: 'my_orders', title: '📋 আমার অর্ডার' }
                    },
                    {
                        type: 'reply',
                        reply: { id: 'help', title: 'ℹ️ সাহায্য' }
                    }
                ]
            }
        }
    });
}

// ==================== ৮. অর্ডার প্রসেস শুরু ====================
async function startOrderProcess(phoneNumber, serviceId) {
    const services = await loadServices();
    const service = services[serviceId];
    
    if (!service) {
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: '❌ সার্ভিস খুঁজে পাওয়া যায়নি।' }
        });
        return;
    }
    
    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { 
            body: `✅ ${service.name} সিলেক্ট করেছেন!\n\n💰 দাম: ${service.price} টাকা\n⏱️ ডেলিভারি সময়: ${service.deliveryTime}\n\n📝 এখন আপনার তথ্য দিন:` 
        }
    });
    
    userStates[phoneNumber] = {
        serviceId: serviceId,
        fieldIndex: 0,
        formData: {},
        state: 'collecting',
        service: service
    };
    
    await askNextField(phoneNumber);
}

// ==================== ৯. পরবর্তী তথ্য চাওয়া ====================
async function askNextField(phoneNumber) {
    const state = userStates[phoneNumber];
    if (!state) return;
    
    const service = state.service;
    const fields = service.fields;
    const idx = state.fieldIndex;
    
    if (idx >= fields.length) {
        await showConfirmation(phoneNumber);
        return;
    }
    
    const fieldName = fields[idx];
    const fieldLabels = {
        'name': '📛 আপনার নাম',
        'nid': '🆔 NID নম্বর',
        'voter': '🆔 ভোটার নম্বর',
        'from': '🆔 FROM নম্বর',
        'dob': '📅 জন্ম তারিখ',
        'father': '👨 পিতার নাম',
        'mother': '👩 মাতার নাম',
        'voter_address': '📍 ভোটারের ঠিকানা',
        'division': '📌 বিভাগের নাম',
        'district': '📌 জেলার নাম',
        'upazila': '📌 উপজেলার নাম',
        'union': '📌 ইউনিয়ন নাম',
        'ward': '📌 ওয়ার্ড নাম্বার',
        'village': '📌 গ্রামের নাম',
        'address_type': '📍 কোন ঠিকানায় চেক করবেন?\n\n১. এক ঠিকানা\n২. দুই ঠিকানা',
        'address1': '📍 প্রথম ঠিকানা লিখুন',
        'address2': '📍 দ্বিতীয় ঠিকানা লিখুন'
    };
    
    await sendWhatsAppMessage(phoneNumber, {
        type: 'text',
        text: { body: `${fieldLabels[fieldName] || fieldName} দিন:` }
    });
}

// ==================== ১০. ইউজার ইনপুট ====================
async function handleUserInput(phoneNumber, message) {
    const state = userStates[phoneNumber];
    
    if (!state || state.state === 'menu') {
        await sendServiceMenu(phoneNumber);
        return;
    }
    
    if (state.state === 'collecting') {
        const service = state.service;
        const fields = service.fields;
        const idx = state.fieldIndex;
        const fieldName = fields[idx];
        
        if (fieldName === 'address_type') {
            if (message === '১' || message.toLowerCase() === 'এক' || message.toLowerCase() === '1') {
                state.formData['address_type'] = 'one';
            } else if (message === '২' || message.toLowerCase() === 'দুই' || message.toLowerCase() === '2') {
                state.formData['address_type'] = 'two';
            } else {
                await sendWhatsAppMessage(phoneNumber, {
                    type: 'text',
                    text: { body: '❌ দয়া করে "১" বা "২" লিখুন।' }
                });
                return;
            }
        } else {
            state.formData[fieldName] = message;
        }
        
        state.fieldIndex++;
        await askNextField(phoneNumber);
    }
}

// ==================== ১১. কনফর্মেশন ====================
async function showConfirmation(phoneNumber) {
    const state = userStates[phoneNumber];
    if (!state) return;
    
    const service = state.service;
    
    let confirmText = `✅ অর্ডার কনফর্মেশন\n\n`;
    confirmText += `📦 সার্ভিস: ${service.name}\n`;
    confirmText += `💰 দাম: ${service.price} টাকা\n`;
    confirmText += `⏱️ ডেলিভারি সময়: ${service.deliveryTime}\n\n`;
    confirmText += `📝 আপনার তথ্য:\n`;
    
    const labels = {
        'name': 'নাম', 'nid': 'NID', 'voter': 'ভোটার', 'from': 'FROM',
        'dob': 'জন্ম তারিখ', 'father': 'পিতার নাম', 'mother': 'মাতার নাম',
        'voter_address': 'ভোটারের ঠিকানা', 'division': 'বিভাগ',
        'district': 'জেলা', 'upazila': 'উপজেলা',
        'union': 'ইউনিয়ন', 'ward': 'ওয়ার্ড', 'village': 'গ্রাম',
        'address_type': 'ঠিকানা টাইপ', 'address1': 'প্রথম ঠিকানা',
        'address2': 'দ্বিতীয় ঠিকানা'
    };
    
    Object.keys(state.formData).forEach(key => {
        confirmText += `• ${labels[key] || key}: ${state.formData[key]}\n`;
    });
    
    confirmText += `\nঅর্ডার নিশ্চিত করতে বাটনে চাপ দিন:`;
    
    await sendWhatsAppMessage(phoneNumber, {
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: confirmText },
            action: {
                buttons: [
                    {
                        type: 'reply',
                        reply: { id: 'confirm_yes', title: '✅ হ্যাঁ' }
                    },
                    {
                        type: 'reply',
                        reply: { id: 'confirm_no', title: '❌ বাতিল' }
                    }
                ]
            }
        }
    });
    
    state.state = 'confirming';
}

// ==================== ১২. কনফর্মেশন হ্যান্ডল ====================
async function handleConfirmation(phoneNumber, decision) {
    const state = userStates[phoneNumber];
    if (!state) return;
    
    if (decision === 'confirm_yes') {
        const service = state.service;
        const orderId = await saveOrder(
            phoneNumber,
            state.serviceId,
            service.name,
            service.price,
            state.formData
        );
        
        if (!orderId) {
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: '❌ অর্ডার সেভ করতে ব্যর্থ হয়েছে।' }
            });
            delete userStates[phoneNumber];
            return;
        }
        
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { 
                body: `✅ অর্ডার সফল!\n\n🆔 অর্ডার আইডি: #${orderId}\n📦 সার্ভিস: ${service.name}\n💰 দাম: ${service.price} টাকা\n⏳ স্ট্যাটাস: পেন্ডিং\n\nআমরা খুব শীঘ্রই ডেলিভারি দেব।` 
            }
        });
        
        // অ্যাডমিন নোটিফিকেশন
        const adminText = `🛒 নতুন অর্ডার!\n\n🆔 অর্ডার আইডি: #${orderId}\n👤 ইউজার: ${phoneNumber}\n📦 সার্ভিস: ${service.name}\n💰 দাম: ${service.price} টাকা\n📝 তথ্য: ${JSON.stringify(state.formData)}\n\nডেলিভারি দিতে: !deliver ${orderId}`;
        
        await sendWhatsAppMessage(ADMIN_PHONE, {
            type: 'text',
            text: { body: adminText }
        });
        
        delete userStates[phoneNumber];
    } else if (decision === 'confirm_no') {
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: '❌ অর্ডার বাতিল করা হয়েছে।' }
        });
        delete userStates[phoneNumber];
    }
}

// ==================== ১৩. অ্যাডমিন ডেলিভারি ====================
async function handleAdminDelivery(phoneNumber, orderId, deliveryType, content) {
    const success = await updateOrder(orderId, 'delivered', deliveryType, content);
    
    if (!success) {
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: '❌ অর্ডার খুঁজে পাওয়া যায়নি।' }
        });
        return;
    }
    
    const order = await getOrderDetails(orderId);
    if (order) {
        let deliveryText = `✅ অ্যাডমিন আপনার ডেলিভারি পাঠিয়েছে\n\n`;
        if (deliveryType === 'pdf') {
            deliveryText += `📎 PDF: ${content}\n\n`;
        } else {
            deliveryText += `${content}\n\n`;
        }
        deliveryText += `ধন্যবাদ!`;
        
        await sendWhatsAppMessage(order.userPhone, {
            type: 'text',
            text: { body: deliveryText }
        });
        
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: `✅ অর্ডার #${orderId} ডেলিভারি সম্পন্ন!` }
        });
    }
    
    delete adminStates[phoneNumber];
}

// ==================== ১৪. অ্যাডমিন বাতিল ====================
async function handleAdminCancel(phoneNumber, orderId, reason) {
    const success = await updateOrder(orderId, 'cancelled', '', '', reason);
    
    if (!success) {
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: '❌ অর্ডার খুঁজে পাওয়া যায়নি।' }
        });
        return;
    }
    
    const order = await getOrderDetails(orderId);
    if (order) {
        await sendWhatsAppMessage(order.userPhone, {
            type: 'text',
            text: { 
                body: `❌ অর্ডার বাতিল করা হয়েছে\n\nকারণ: ${reason}\n\nযোগাযোগ: ${ADMIN_PHONE}` 
            }
        });
        
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: `✅ অর্ডার #${orderId} বাতিল করা হয়েছে!\nকারণ: ${reason}` }
        });
    }
}

// ==================== ১৫. অ্যাডমিন কমান্ড ====================
async function handleAdminCommand(phoneNumber, message) {
    if (!await isAdmin(phoneNumber)) {
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: '⛔ আপনি অ্যাডমিন নন।' }
        });
        return;
    }
    
    if (message.startsWith('!deliver')) {
        const parts = message.split(' ');
        if (parts.length < 2) {
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: '⚠️ ফরম্যাট: !deliver ORDER_ID' }
            });
            return;
        }
        const orderId = parts[1];
        adminStates[phoneNumber] = { orderId, state: 'awaiting_delivery_type' };
        
        await sendWhatsAppMessage(phoneNumber, {
            type: 'interactive',
            interactive: {
                type: 'button',
                body: { text: `📦 অর্ডার #${orderId} ডেলিভারি` },
                action: {
                    buttons: [
                        { type: 'reply', reply: { id: 'deliver_text', title: '📝 টেক্সট' } },
                        { type: 'reply', reply: { id: 'deliver_pdf', title: '📎 PDF' } }
                    ]
                }
            }
        });
        return;
    }
    
    if (message.startsWith('!cancel')) {
        const parts = message.split(' ');
        if (parts.length < 3) {
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: '⚠️ ফরম্যাট: !cancel ORDER_ID কারণ' }
            });
            return;
        }
        const orderId = parts[1];
        const reason = parts.slice(2).join(' ');
        await handleAdminCancel(phoneNumber, orderId, reason);
        return;
    }
    
    if (message === '!stats') {
        try {
            const response = await sheets.spreadsheets.values.get({
                spreadsheetId: SHEET_ID,
                range: 'Orders!A:K'
            });
            const rows = response.data.values || [];
            let total = 0, pending = 0, delivered = 0, cancelled = 0, revenue = 0;
            rows.slice(1).forEach(row => {
                total++;
                if (row[6] === 'pending') pending++;
                else if (row[6] === 'delivered') { delivered++; revenue += parseInt(row[4]) || 0; }
                else if (row[6] === 'cancelled') cancelled++;
            });
            
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { 
                    body: `📊 পরিসংখ্যান\n\n📦 মোট: ${total}\n⏳ পেন্ডিং: ${pending}\n✅ সম্পন্ন: ${delivered}\n❌ বাতিল: ${cancelled}\n💰 আয়: ${revenue} টাকা` 
                }
            });
        } catch (error) {
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: '❌ পরিসংখ্যান দেখাতে ব্যর্থ।' }
            });
        }
        return;
    }
}

// ==================== ১৬. ইউজার অর্ডার ====================
async function showUserOrders(phoneNumber) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: 'Orders!A:K'
        });
        const rows = response.data.values || [];
        const orders = rows.slice(1).filter(row => row[1] === phoneNumber);
        
        if (orders.length === 0) {
            await sendWhatsAppMessage(phoneNumber, {
                type: 'text',
                text: { body: '❌ আপনার কোনো অর্ডার নেই।' }
            });
            return;
        }
        
        let text = '📋 আপনার অর্ডারসমূহ:\n\n';
        orders.forEach((order, i) => {
            const statusEmoji = order[6] === 'pending' ? '⏳' : (order[6] === 'delivered' ? '✅' : '❌');
            const statusText = order[6] === 'pending' ? 'পেন্ডিং' : (order[6] === 'delivered' ? 'সফল' : 'বাতিল');
            text += `${i+1}. #${order[0]} | ${order[3]} | ${statusEmoji} ${statusText}\n`;
        });
        
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: text }
        });
    } catch (error) {
        await sendWhatsAppMessage(phoneNumber, {
            type: 'text',
            text: { body: '❌ অর্ডার দেখাতে ব্যর্থ।' }
        });
    }
}

// ==================== ১৭. ওয়েবহুক ====================
app.post('/webhook', async (req, res) => {
    const body = req.body;
    
    if (body.entry) {
        body.entry.forEach(entry => {
            entry.changes.forEach(async change => {
                if (change.value.messages) {
                    for (const message of change.value.messages) {
                        const phoneNumber = message.from;
                        
                        if (message.type === 'text') {
                            const text = message.text.body;
                            
                            if (text.startsWith('!') && await isAdmin(phoneNumber)) {
                                await handleAdminCommand(phoneNumber, text);
                                continue;
                            }
                            
                            if (text.toLowerCase() === 'menu' || text.toLowerCase() === 'start') {
                                await sendServiceMenu(phoneNumber);
                                continue;
                            }
                            
                            if (adminStates[phoneNumber] && adminStates[phoneNumber].state === 'awaiting_text') {
                                await handleAdminDelivery(phoneNumber, adminStates[phoneNumber].orderId, 'text', text);
                                continue;
                            }
                            
                            if (adminStates[phoneNumber] && adminStates[phoneNumber].state === 'awaiting_pdf') {
                                await handleAdminDelivery(phoneNumber, adminStates[phoneNumber].orderId, 'pdf', text);
                                continue;
                            }
                            
                            await handleUserInput(phoneNumber, text);
                        }
                        
                        if (message.type === 'interactive') {
                            const buttonId = message.interactive.button_reply?.id;
                            
                            if (buttonId === 'my_orders') {
                                await showUserOrders(phoneNumber);
                                continue;
                            }
                            
                            if (buttonId === 'help') {
                                await sendWhatsAppMessage(phoneNumber, {
                                    type: 'text',
                                    text: { body: 'ℹ️ সাহায্য\n\n"menu" লিখে সার্ভিস দেখুন\n"my orders" লিখে অর্ডার দেখুন' }
                                });
                                continue;
                            }
                            
                            if (buttonId && buttonId.startsWith('service_')) {
                                const serviceId = buttonId.replace('service_', '');
                                await startOrderProcess(phoneNumber, serviceId);
                                continue;
                            }
                            
                            if (buttonId === 'confirm_yes' || buttonId === 'confirm_no') {
                                await handleConfirmation(phoneNumber, buttonId);
                                continue;
                            }
                            
                            if (buttonId === 'deliver_text' || buttonId === 'deliver_pdf') {
                                const type = buttonId === 'deliver_text' ? 'awaiting_text' : 'awaiting_pdf';
                                adminStates[phoneNumber].state = type;
                                const label = buttonId === 'deliver_text' ? 'টেক্সট' : 'PDF লিংক';
                                await sendWhatsAppMessage(phoneNumber, {
                                    type: 'text',
                                    text: { body: `📝 ${label} লিখুন:` }
                                });
                                continue;
                            }
                        }
                    }
                }
            });
        });
    }
    res.sendStatus(200);
});

// ==================== ১৮. সার্ভার চালু ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🤖 বট চালু হয়েছে! পোর্ট: ${PORT}`);
});