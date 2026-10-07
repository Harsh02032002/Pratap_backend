'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });
const mongoose = require('mongoose');
const { sendOTPSMS, formatPhoneNumber } = require('../utils/smsService');
const mailer = require('../utils/mailer');

async function testOtpSend() {
  const rawPhone = '9464165010';
  const formattedPhone = formatPhoneNumber(rawPhone);
  const testOtp = String(Math.floor(100000 + Math.random() * 900000));

  console.log(`\n==============================================`);
  console.log(`🚀 TESTING OTP SEND TO: ${rawPhone} (${formattedPhone})`);
  console.log(`🔑 GENERATED TEST OTP: ${testOtp}`);
  console.log(`==============================================\n`);

  if (process.env.MONGO_URI) {
    try {
      console.log('Connecting to MongoDB...');
      await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 5000 });
      console.log('MongoDB Connected ✅\n');
    } catch (e) {
      console.warn('MongoDB connection skipped/warning:', e.message);
    }
  }

  // 1. Check Environment Configurations
  const mailerCfg = mailer.getMailerConfig();
  console.log('--- 1. Environment Configuration Check ---');
  console.log('NODE_ENV:', process.env.NODE_ENV || 'not set');
  console.log('Fast2SMS Key:', process.env.FAST2SMS_API_KEY ? 'CONFIGURED ✅' : 'MISSING ❌');
  console.log('MSG91 Auth Key:', process.env.MSG91_AUTH_KEY ? 'CONFIGURED ✅' : 'MISSING ❌');
  console.log('Twilio Account SID:', process.env.TWILIO_ACCOUNT_SID ? 'CONFIGURED ✅' : 'MISSING ❌');
  console.log('WhatsApp Token:', mailerCfg.whatsappAccessToken ? 'CONFIGURED ✅' : 'MISSING ❌');
  console.log('WhatsApp Phone Number ID:', mailerCfg.whatsappPhoneNumberId || 'MISSING ❌');
  console.log('WhatsApp OTP Template (Fallback active):', mailerCfg.whatsappOtpTemplateName);

  // 2. Try Cellular SMS
  console.log('\n--- 2. Testing Cellular SMS Providers (sendOTPSMS) ---');
  try {
    const smsResult = await sendOTPSMS(formattedPhone, testOtp, 'verification');
    console.log('SMS Delivery Result:', smsResult);
  } catch (err) {
    console.error('SMS Provider Error:', err.message);
  }

  // 3. Try Direct WhatsApp OTP
  console.log('\n--- 3. Testing WhatsApp Direct OTP (Meta Graph API) ---');
  try {
    const waResult = await mailer.sendDirectWhatsAppOtp(formattedPhone, testOtp);
    console.log('WhatsApp Direct OTP Result:', waResult ? 'SUCCESS ✅ (OTP sent to WhatsApp on 9464165010)' : 'FAILED / API REJECTED ❌');
  } catch (err) {
    console.error('WhatsApp Direct OTP Error:', err.message);
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  console.log(`\n==============================================`);
  console.log(`💡 TEST COMPLETE! Run again in terminal: node scratch/test_otp_send.js`);
  console.log(`==============================================\n`);
}

testOtpSend().catch(console.error);
