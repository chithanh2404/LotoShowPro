
// Google Apps Script - dán vào script.google.com
// Deploy as Web App, Anyone

function doPost(e){
  var data = JSON.parse(e.postData.contents);
  if(data.action==='sendOTP'){
    var email = data.email;
    var otp = data.otp;
    MailApp.sendEmail({
      to: email,
      subject: 'Mã OTP Loto Online - '+otp,
      htmlBody: '<div style="font-family:sans-serif;padding:20px;background:#0f172a;color:#fff;border-radius:10px"><h2 style="color:#00d2ff">LOTO ONLINE</h2><p>Mã OTP của bạn là:</p><h1 style="letter-spacing:5px;color:#d4af37">'+otp+'</h1><p>Hết hạn sau 10 phút.</p></div>'
    });
    return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);
  }
  return ContentService.createTextOutput(JSON.stringify({ok:true})).setMimeType(ContentService.MimeType.JSON);
}
function doGet(){ return ContentService.createTextOutput('Loto OTP Service Running'); }
