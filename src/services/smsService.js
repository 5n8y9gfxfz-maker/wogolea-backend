const axios = require('axios');

const MSG91_AUTH_KEY = process.env.MSG91_AUTH_KEY;
const MSG91_SENDER_ID = process.env.MSG91_SENDER_ID || 'WGLAPP';
const MSG91_TEMPLATE_ID = process.env.MSG91_TEMPLATE_ID;

// Generate 6-digit OTP
function generateOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send OTP via MSG91 (or mock in development)
async function sendOTP(phone, otp) {
  // In development, just log the OTP
  if (process.env.NODE_ENV !== 'production' || !MSG91_AUTH_KEY) {
    console.log(`[DEV MODE] OTP for ${phone}: ${otp}`);
    return { success: true, message: 'OTP sent (dev mode)', otp };
  }

  try {
    // MSG91 API endpoint
    const response = await axios.post(
      'https://api.msg91.com/api/v5/otp',
      {
        template_id: MSG91_TEMPLATE_ID,
        mobile: phone.replace(/^\+/, ''), // Remove + if present
        authkey: MSG91_AUTH_KEY,
        otp: otp
      },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );

    if (response.data.type === 'success') {
      return { success: true, message: 'OTP sent successfully' };
    } else {
      console.error('MSG91 Error:', response.data);
      return { success: false, message: response.data.message || 'Failed to send OTP' };
    }
  } catch (error) {
    console.error('SMS Service Error:', error.response?.data || error.message);

    // Fallback to dev mode on error
    console.log(`[FALLBACK] OTP for ${phone}: ${otp}`);
    return { success: true, message: 'OTP sent (fallback mode)', otp };
  }
}

// Verify OTP via MSG91 (we handle verification ourselves using database)
async function verifyOTPWithMSG91(phone, otp) {
  if (process.env.NODE_ENV !== 'production' || !MSG91_AUTH_KEY) {
    return { success: true }; // We verify from our database in dev mode
  }

  try {
    const response = await axios.get(
      `https://api.msg91.com/api/v5/otp/verify?mobile=${phone.replace(/^\+/, '')}&otp=${otp}&authkey=${MSG91_AUTH_KEY}`
    );

    return { success: response.data.type === 'success' };
  } catch (error) {
    console.error('OTP Verification Error:', error.response?.data || error.message);
    return { success: false };
  }
}

module.exports = {
  generateOTP,
  sendOTP,
  verifyOTPWithMSG91
};
