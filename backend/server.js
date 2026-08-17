
import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { Server } from 'socket.io';
import http from 'http';
import dotenv from 'dotenv';
import { nanoid } from 'nanoid';

dotenv.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

app.use(cors({ origin: "*" }));
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const APPSCRIPT_URL = process.env.APPSCRIPT_URL;

// ===== UTILS: Tạo vé Loto chuẩn Việt Nam giống ảnh bạn gửi =====
// Vé 3 hàng x 9 cột, mỗi hàng 5 số, 4 ô trống màu đỏ
// Cột 0:1-9, 1:10-19, 2:20-29, 3:30-39, 4:40-49, 5:50-59, 6:60-69, 7:70-79, 8:80-90
function generateLotoTicket() {
  const ticket = Array(3).fill(0).map(()=> Array(9).fill(null));
  // Mỗi cột phải có ít nhất 1 số
  const colCounts = Array(9).fill(0);
  // Tổng 15 số (5 per row)
  // B1: đảm bảo mỗi cột có 1 số ngẫu nhiên ở hàng ngẫu nhiên
  for(let c=0;c<9;c++){
    const r = Math.floor(Math.random()*3);
    ticket[r][c] = getRandomInCol(c);
    colCounts[c]++;
  }
  // B2: điền thêm để mỗi hàng đủ 5 số (hiện mỗi hàng có khoảng 3 số)
  for(let r=0;r<3;r++){
    let numsInRow = ticket[r].filter(v=>v!==null).length;
    while(numsInRow < 5){
      const c = Math.floor(Math.random()*9);
      if(ticket[r][c]===null){
        // tránh trùng số trong cùng cột
        let val;
        let tries=0;
        do{
          val = getRandomInCol(c);
          tries++;
        }while(columnHas(ticket,val,c) && tries<20);
        ticket[r][c]=val;
        numsInRow++;
      }
    }
    // nếu quá 5 thì xóa bớt
    while(numsInRow > 5){
      const filled = ticket[r].map((v,i)=> v!==null?i:null).filter(v=>v!==null);
      const toRemove = filled[Math.floor(Math.random()*filled.length)];
      // không để cột trống hoàn toàn
      if(colCounts[toRemove] > 1){
        ticket[r][toRemove]=null;
        colCounts[toRemove]--;
        numsInRow--;
      } else break;
    }
  }
  // Sắp xếp số trong mỗi cột tăng dần từ trên xuống cho đẹp như vé thật
  for(let c=0;c<9;c++){
    const vals = [];
    for(let r=0;r<3;r++) if(ticket[r][c]!==null) vals.push(ticket[r][c]);
    vals.sort((a,b)=>a-b);
    let idx=0;
    for(let r=0;r<3;r++) if(ticket[r][c]!==null) ticket[r][c]=vals[idx++];
  }
  return ticket;
}
function getRandomInCol(c){
  const ranges = [[1,9],[10,19],[20,29],[30,39],[40,49],[50,59],[60,69],[70,79],[80,90]];
  const [min,max] = ranges[c];
  return Math.floor(Math.random()*(max-min+1))+min;
}
function columnHas(ticket,val,c){
  for(let r=0;r<3;r++) if(ticket[r][c]===val) return true;
  return false;
}
function checkWin(ticket, drawnSet){
  // Thắng khi có 1 hàng đủ 5 số đều đã ra
  for(let r=0;r<3;r++){
    const rowNums = ticket[r].filter(v=>v!==null);
    if(rowNums.every(n=>drawnSet.has(n))) return true;
  }
  return false;
}

// ===== API: Auth + OTP qua Apps Script - FIXED hỗ trợ cả GET và POST =====
async function handleOtpSend(req,res){
  const email = (req.body && req.body.email) || req.query.email;
  if(!email) return res.status(400).json({ok:false, message:"Thiếu email - gửi ?email=... hoặc body {email}"});
  const otp = Math.floor(100000+Math.random()*900000).toString();
  try{
    await supabase.from('password_otps').insert({email, otp});
  }catch(e){ console.log("DB insert otp error", e.message); }
  try{
    const url = `${APPSCRIPT_URL}?action=sendOTP&email=${encodeURIComponent(email)}&otp=${otp}&type=forgot&ip=${encodeURIComponent(req.ip||'')}`;
    console.log("Calling Apps Script:", url);
    const resp = await fetch(url);
    const text = await resp.text();
    console.log("Apps Script response:", text);
    let json;
    try{ json = JSON.parse(text); }catch{}
    if(json && json.success === false){
      return res.status(500).json({ok:false, message: json.message || text, raw:text});
    }
    if(text.includes("❌")){
      return res.status(500).json({ok:false, message:text, raw:text});
    }
    res.json({ok:true, message:"Đã gửi OTP tới " + email, raw:text, otp_debug: otp});
  }catch(e){ 
    console.error("OTP send error", e);
    res.status(500).json({ok:false, error:e.message}); 
  }
}
app.post('/api/otp/send', handleOtpSend);
app.get('/api/otp/send', handleOtpSend);


// ===== API: Tạo vé ngẫu nhiên cho chọn =====
app.get('/api/tickets/generate', (req,res)=>{
  const count = parseInt(req.query.count||'6');
  const tickets = Array(count).fill(0).map(()=> generateLotoTicket());
  res.json({tickets});
});

// ===== API: Tạo phòng =====
app.post('/api/rooms', async (req,res)=>{
  const {hostId, name, password, betAmount, maxPlayers} = req.body;
  const id = 'LOTO-'+nanoid(6).toUpperCase();
  const fee = 20;
  const {data, error} = await supabase.from('rooms').insert({id, name, host_id:hostId, password: password||null, bet_amount:betAmount, max_players:maxPlayers||5, fee_percent:fee, status:'waiting'}).select().single();
  if(error) return res.status(500).json({error});
  // host vào phòng luôn
  const ticket = generateLotoTicket();
  await supabase.from('room_players').insert({room_id:id, user_id:hostId, ticket, is_bot:false});
  res.json(data);
});

// ===== SOCKET.IO GAME LOOP =====
const activeGames = new Map(); // roomId -> {drawn:[], interval, numbers: shuffled 1-90}

io.on('connection', (socket)=>{
  console.log('socket connected', socket.id);

  socket.on('join-room', async ({roomId, userId, password})=>{
    const {data: room} = await supabase.from('rooms').select('*').eq('id',roomId).single();
    if(!room) return socket.emit('error','Phòng không tồn tại');
    if(room.password && room.password!==password) return socket.emit('error','Sai mật khẩu phòng');
    socket.join(roomId);
    // nếu chưa trong phòng thì thêm
    const {data: exist} = await supabase.from('room_players').select('*').eq('room_id',roomId).eq('user_id',userId).single();
    if(!exist){
      const ticket = generateLotoTicket();
      await supabase.from('room_players').insert({room_id:roomId, user_id:userId, ticket});
    }
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
    io.to(roomId).emit('players-update', players);
  });

  // Chế độ solo: tạo phòng ảo với bot
  socket.on('create-solo', async ({userId, botCount, betAmount, ticket})=>{
    const roomId = 'SOLO-'+nanoid(6).toUpperCase();
    // phí giảm dần: 20% cho 1 bot, mỗi bot thêm giảm 2%, min 5%
    const fee = Math.max(5, 20 - (botCount-1)*2);
    await supabase.from('rooms').insert({id:roomId, host_id:userId, bet_amount:betAmount, max_players:botCount+1, fee_percent:fee, status:'waiting', name:`Solo ${botCount} bot`});
    await supabase.from('room_players').insert({room_id:roomId, user_id:userId, ticket, is_bot:false});
    for(let i=0;i<botCount;i++){
      await supabase.from('room_players').insert({room_id:roomId, is_bot:true, bot_name:`Bot ${i+1}`, ticket: generateLotoTicket()});
    }
    socket.join(roomId);
    socket.emit('solo-created', {roomId, fee});
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
    io.to(roomId).emit('players-update', players);
  });

  socket.on('start-game', async ({roomId})=>{
    if(activeGames.has(roomId)) return;
    await supabase.from('rooms').update({status:'counting'}).eq('id',roomId);
    io.to(roomId).emit('countdown-start'); // client đếm 3,2,1
    setTimeout(async ()=>{
      await supabase.from('rooms').update({status:'playing', current_numbers:[]}).eq('id',roomId);
      const allNumbers = Array.from({length:90},(_,i)=>i+1).sort(()=>Math.random()-0.5);
      let idx=0;
      const drawn = [];
      const drawnSet = new Set();
      const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
      const interval = setInterval(async ()=>{
        if(idx>=90){ clearInterval(interval); return; }
        const num = allNumbers[idx++];
        drawn.push(num);
        drawnSet.add(num);
        await supabase.from('rooms').update({current_numbers:drawn}).eq('id',roomId);
        io.to(roomId).emit('number-drawn', {number:num, drawn});

        // check win
        for(const p of players){
          if(checkWin(p.ticket, drawnSet)){
            clearInterval(interval);
            activeGames.delete(roomId);
            // xử lý tiền
            const {data: room} = await supabase.from('rooms').select('*').eq('id',roomId).single();
            const bet = room.bet_amount;
            const feePercent = room.fee_percent;
            const totalPot = players.length * bet;
            const fee = Math.floor(totalPot * feePercent / 100);
            const winAmount = totalPot - fee;

            // trừ tiền người thua
            for(const pl of players){
              if(pl.user_id && pl.id !== p.id){
                const {data: prof} = await supabase.from('profiles').select('balance').eq('id',pl.user_id).single();
                if(prof) await supabase.from('profiles').update({balance: prof.balance - bet}).eq('id',pl.user_id);
              }
              if(pl.user_id === p.user_id){
                const {data: prof} = await supabase.from('profiles').select('balance').eq('id',pl.user_id).single();
                if(prof) await supabase.from('profiles').update({balance: prof.balance + winAmount}).eq('id',pl.user_id);
              }
            }
            await supabase.from('transactions').insert([
              {user_id: p.user_id, type:'win', amount: winAmount, room_id:roomId},
            ]);
            await supabase.from('rooms').update({status:'finished', winner_id: p.user_id || null}).eq('id',roomId);
            io.to(roomId).emit('game-won', {winner: p, number: num, winAmount, fee, totalPot});
            break;
          }
        }
      }, 4000); // 4s một số (đủ thời gian nghe audio)
      activeGames.set(roomId, {interval, drawn});
    }, 4000); // sau 3,2,1
  });

  socket.on('leave-room', (roomId)=> socket.leave(roomId));
});

app.get('/', (req,res)=> res.send('Loto Online Backend Running'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Server running on '+PORT));
