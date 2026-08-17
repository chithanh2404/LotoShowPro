
# Loto Online - Blogger + Supabase + Render

## Cấu trúc
- /backend : Node.js + Express + Socket.io -> Deploy lên Render
- /supabase : schema.sql
- /blogger : LotoOnline_Blogger.xml -> Up lên Blogger

## Deploy nhanh
1. Supabase: chạy supabase/schema.sql
2. GitHub: push thư mục backend lên repo
3. Render: New Web Service -> Env vars:
   - SUPABASE_URL
   - SUPABASE_SERVICE_KEY
   - APPSCRIPT_URL=https://script.google.com/macros/s/AKfycbwKymV4CKouo3JDEkHvrsQvd7Ax6KBqUiTW-rPyEYMe37tfMA0_ieGsfUhjyJqh1BeIJw/exec
   - FRONTEND_URL=https://yourblog.blogspot.com
4. Blogger: Theme > Edit HTML -> dán blogger/LotoOnline_Blogger.xml và sửa CONFIG SUPABASE_URL, ANON_KEY, BACKEND_URL

## Tính năng
- Đăng ký/đăng nhập Supabase, tặng 100k xu
- OTP quên mật khẩu qua Apps Script
- Solo vs Bot: phí = max(5%, 20%-(bot-1)*2%)
- Multiplayer phòng có pass
- Vé Loto chuẩn 3x9 ô đỏ trắng như ảnh mẫu
- Countdown 3,2,1 rồi quay auto, highlight vé, tính tiền thắng trừ phí sàn

Tác giả: Upgrade từ Lotoshowpro-Fixed-Final-Smooth.html
