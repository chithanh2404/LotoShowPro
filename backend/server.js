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

// Helper lay username tu profiles
async function getUsernameById(userId){
  try{
    const {data: profile} = await supabase.from('profiles').select('username, name, display_name').eq('id', userId).maybeSingle();
    if(profile){
      return profile.username || profile.name || profile.display_name || null;
    }
  }catch(e){ console.log('getUsername error', e.message); }
  return null;
}

// ===== UTILS: Tạo vé Loto chuẩn Việt Nam =====
function generateLotoTicket() {
  const ticket = Array(3).fill(0).map(()=> Array(9).fill(null));
  const colCounts = Array(9).fill(0);
  for(let c=0;c<9;c++){
    const r = Math.floor(Math.random()*3);
    ticket[r][c] = getRandomInCol(c);
    colCounts[c]++;
  }
  for(let r=0;r<3;r++){
    let numsInRow = ticket[r].filter(v=>v!==null).length;
    while(numsInRow < 5){
      const c = Math.floor(Math.random()*9);
      if(ticket[r][c]===null){
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
    while(numsInRow > 5){
      const filled = ticket[r].map((v,i)=> v!==null?i:null).filter(v=>v!==null);
      const toRemove = filled[Math.floor(Math.random()*filled.length)];
      if(colCounts[toRemove] > 1){
        ticket[r][toRemove]=null;
        colCounts[toRemove]--;
        numsInRow--;
      } else break;
    }
  }
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
  for(let r=0;r<3;r++){
    const rowNums = ticket[r].filter(v=>v!==null);
    if(rowNums.every(n=>drawnSet.has(n))) return true;
  }
  return false;
}

// ===== AUDIO VARIANTS - dong bo nhac cho tat ca thiet bi =====
// So luong bien the bai hat cho moi so (tuong ung audioVariants ben frontend)
// De dong bo, server se tinh variant dua tren so + thu tu quay, khong random rieng
function getAudioVariantForNumber(num, drawIndex, roomId){
  // Deterministic: dung hash don gian de tat ca client phat cung 1 ban nhac
  // Vi du: co 2-3 bien the cho moi so, ta chon dua tren drawIndex + num
  // Gia su moi so co toi da 3 bien the
  const maxVariants = 3; // neu so nao chi co 1 file thi client se fallback ve 0
  // Hash: (num * 7 + drawIndex * 13 + roomId char code sum) % maxVariants
  let roomHash = 0;
  if(roomId){
    for(let i=0;i<roomId.length;i++) roomHash += roomId.charCodeAt(i);
  }
  const variant = (num * 7 + drawIndex * 13 + roomHash) % maxVariants;
  return variant;
}

// ===== API: Auth + OTP =====
async function handleOtpSend(req,res){
  const emailRaw = (req.body && req.body.email) || req.query.email;
  if(!emailRaw) return res.status(400).json({ok:false, message:"Thiếu email"});
  const email = emailRaw.toLowerCase().trim();
  try{
    const {data: profile} = await supabase.from('profiles').select('id,email').eq('email', email).maybeSingle();
    let userExists = !!profile;
    if(!userExists){
      try{
        const {data: {users}, error} = await supabase.auth.admin.listUsers();
        if(!error && users){
          userExists = users.some(u => u.email && u.email.toLowerCase() === email);
        }
      }catch(e){ console.log("listUsers error", e.message); }
    }
    if(!userExists){
      return res.status(404).json({ok:false, message:"Email không tồn tại!"});
    }
  }catch(checkErr){
    console.log("Check email exists error:", checkErr.message);
  }
  const otp = Math.floor(100000+Math.random()*900000).toString();
  try{ await supabase.from('password_otps').insert({email, otp}); }catch(e){}
  try{
    const url = `${APPSCRIPT_URL}?action=sendOTP&email=${encodeURIComponent(email)}&otp=${otp}&type=forgot&ip=${encodeURIComponent(req.ip||'')}`;
    const resp = await fetch(url);
    const text = await resp.text();
    let json; try{ json = JSON.parse(text); }catch{}
    if(json && json.success === false){
      return res.status(500).json({ok:false, message: json.message || text});
    }
    if(text.includes("❌")){
      return res.status(500).json({ok:false, message:text});
    }
    res.json({ok:true, message:"Đã gửi OTP tới " + email, otp_debug: otp});
  }catch(e){ res.status(500).json({ok:false, error:e.message}); }
}
app.post('/api/otp/send', handleOtpSend);
app.get('/api/otp/send', handleOtpSend);

app.post('/api/auth/confirm-all', async (req,res)=>{
  try{
    const {data:{users}, error} = await supabase.auth.admin.listUsers();
    if(error) return res.status(500).json({ok:false, error:error.message});
    let fixed = 0;
    for(const u of users){
      if(!u.email_confirmed_at){
        await supabase.auth.admin.updateUserById(u.id, {email_confirm:true});
        fixed++;
      }
    }
    res.json({ok:true, message:`Da xac nhan ${fixed} user`, fixed});
  }catch(e){ res.status(500).json({ok:false, error:e.message}); }
});
app.get('/api/auth/confirm-all', async (req,res)=>{
  try{
    const {data:{users}, error} = await supabase.auth.admin.listUsers();
    if(error) return res.status(500).json({ok:false, error:error.message});
    let fixed = 0;
    for(const u of users){
      if(!u.email_confirmed_at){
        await supabase.auth.admin.updateUserById(u.id, {email_confirm:true});
        fixed++;
      }
    }
    res.json({ok:true, message:`Da xac nhan ${fixed} user`, fixed});
  }catch(e){ res.status(500).json({ok:false, error:e.message}); }
});

app.get('/api/tickets/generate', (req,res)=>{
  const count = parseInt(req.query.count||'6');
  // Tao ve kem mau sac ngau nhien
  const colors = ['#00d2ff','#FFD700','#ff007f','#39ff14','#ff6b35','#9c27b0','#00bcd4','#e91e63'];
  const tickets = Array(count).fill(0).map((_,i)=> ({
    ticket: generateLotoTicket(),
    color: colors[i % colors.length],
    colorIndex: i % colors.length
  }));
  res.json({tickets});
});

app.post('/api/rooms', async (req,res)=>{
  const {hostId, name, password, betAmount, maxPlayers, ticket} = req.body;
  const id = 'LOTO-'+nanoid(6).toUpperCase();
  const fee = 20;
  const {data, error} = await supabase.from('rooms').insert({id, name, host_id:hostId, password: password||null, bet_amount:betAmount, max_players:maxPlayers||5, fee_percent:fee, status:'waiting'}).select().single();
  if(error) return res.status(500).json({error});
  const finalTicket = ticket || generateLotoTicket();
  const username = await getUsernameById(hostId);
  const ticketColor = req.body.ticketColor || '#00d2ff';
  await supabase.from('room_players').insert({room_id:id, user_id:hostId, username: username, ticket: finalTicket, ticket_color: ticketColor, is_bot:false});
  res.json(data);
});

// API lay danh sach ve da duoc chon trong phong - de an di cho nguoi khac
app.get('/api/rooms/:roomId/taken-tickets', async (req,res)=>{
  const {roomId} = req.params;
  try{
    const {data: players, error} = await supabase.from('room_players').select('ticket').eq('room_id', roomId);
    if(error) return res.status(500).json({error: error.message});
    const takenTickets = players ? players.map(p=>p.ticket).filter(t=>t) : [];
    res.json({roomId, takenTickets, count: takenTickets.length});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// API lay thong tin phong chi tiet - kiem tra co bot khong
app.get('/api/rooms/:roomId', async (req,res)=>{
  const {roomId} = req.params;
  try{
    const {data: room, error} = await supabase.from('rooms').select('*').eq('id', roomId).single();
    if(error) return res.status(404).json({error: 'Phong khong ton tai'});
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id', roomId);
    const hasBots = players ? players.some(p=>p.is_bot) : false;
    const realPlayers = players ? players.filter(p=>!p.is_bot) : [];
    res.json({...room, players, hasBots, realPlayersCount: realPlayers.length, totalPlayers: players ? players.length : 0});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// ===== SOCKET.IO GAME LOOP =====
const activeGames = new Map(); // roomId -> {drawn, interval, numbers, players, originalPlayers, roomData}

io.on('connection', (socket)=>{
  console.log('socket connected', socket.id);

  socket.on('join-room', async ({roomId, userId, password, ticket, ticketColor})=>{
    const {data: room} = await supabase.from('rooms').select('*').eq('id',roomId).single();
    if(!room) return socket.emit('error','Phòng không tồn tại');
    if(room.password && room.password!==password) return socket.emit('error','Sai mật khẩu phòng');
    socket.join(roomId);
    socket.data.userId = userId;
    socket.data.roomId = roomId;
    const {data: existList} = await supabase.from('room_players').select('*').eq('room_id',roomId).eq('user_id',userId);
    if(!existList || existList.length===0){
      const finalTicket = ticket || generateLotoTicket();
      const username = await getUsernameById(userId);
      const color = ticketColor || '#'+Math.floor(Math.random()*16777215).toString(16);
      await supabase.from('room_players').insert({room_id:roomId, user_id:userId, username: username, ticket: finalTicket, ticket_color: color, is_bot:false});
    } else if(existList.length>1){
      for(let i=1;i<existList.length;i++){
        await supabase.from('room_players').delete().eq('id', existList[i].id);
      }
    }
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
    io.to(roomId).emit('players-update', players);
    io.to(roomId).emit('room-info', room);
  });

  socket.on('create-solo', async ({userId, botCount, betAmount, ticket, ticketColor})=>{
    const roomId = 'SOLO-'+nanoid(6).toUpperCase();
    const fee = Math.max(5, 20 - (botCount-1)*2);
    await supabase.from('rooms').insert({id:roomId, host_id:userId, bet_amount:betAmount, max_players:botCount+1, fee_percent:fee, status:'waiting', name:`Solo ${botCount} bot`});
    const username = await getUsernameById(userId);
    const color = ticketColor || '#00d2ff';
    await supabase.from('room_players').insert({room_id:roomId, user_id:userId, username: username, ticket: ticket || generateLotoTicket(), ticket_color: color, is_bot:false});
    const botColors = ['#FFD700','#ff6b35','#9c27b0','#00bcd4','#39ff14'];
    for(let i=0;i<botCount;i++){
      await supabase.from('room_players').insert({room_id:roomId, is_bot:true, bot_name:`Bot ${i+1}`, ticket: generateLotoTicket(), ticket_color: botColors[i % botColors.length]});
    }
    socket.join(roomId);
    socket.data.userId = userId;
    socket.data.roomId = roomId;
    socket.emit('solo-created', {roomId, fee});
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
    io.to(roomId).emit('players-update', players);
    io.to(roomId).emit('room-info', room);
  });

  socket.on('start-game', async ({roomId})=>{
    if(activeGames.has(roomId)) return;
    await supabase.from('rooms').update({status:'counting'}).eq('id',roomId);
    io.to(roomId).emit('countdown-start');
    setTimeout(async ()=>{
      await supabase.from('rooms').update({status:'playing', current_numbers:[]}).eq('id',roomId);
      const allNumbers = Array.from({length:90},(_,i)=>i+1).sort(()=>Math.random()-0.5);
      let idx=0;
      const drawn = [];
      const drawnSet = new Set();
      const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
      const {data: roomData} = await supabase.from('rooms').select('*').eq('id',roomId).single();
      activeGames.set(roomId, {drawn, players, originalPlayers: [...players], roomData, allNumbers});
      const interval = setInterval(async ()=>{
        if(idx>=90){ clearInterval(interval); activeGames.delete(roomId); return; }
        const num = allNumbers[idx];
        const audioVariant = getAudioVariantForNumber(num, idx, roomId);
        drawn.push(num);
        drawnSet.add(num);
        idx++;
        await supabase.from('rooms').update({current_numbers:drawn}).eq('id',roomId);
        // Gui kem audioVariant de dong bo nhac cho tat ca thiet bi
        io.to(roomId).emit('number-drawn', {number:num, drawn, audioVariant, drawIndex: drawn.length-1});
        // Update activeGames
        const game = activeGames.get(roomId);
        if(game){ game.drawn = drawn; }

        for(const p of players){
          if(checkWin(p.ticket, drawnSet)){
            clearInterval(interval);
            activeGames.delete(roomId);
            const bet = roomData.bet_amount;
            const feePercent = roomData.fee_percent;
            const totalPot = players.length * bet;
            const fee = Math.floor(totalPot * feePercent / 100);
            const winAmount = totalPot - fee;
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
            await supabase.from('transactions').insert([{user_id: p.user_id, type:'win', amount: winAmount, room_id:roomId}]);
            await supabase.from('rooms').update({status:'finished', winner_id: p.user_id || null}).eq('id',roomId);
            io.to(roomId).emit('game-won', {winner: p, number: num, winAmount, fee, totalPot, reason:'bingo'});
            break;
          }
        }
      }, 4000);
      const game = activeGames.get(roomId);
      if(game) game.interval = interval;
    }, 4000);
  });

  socket.on('leave-room', async ({roomId, userId, username})=>{
    try{
      if(roomId) socket.leave(roomId);
      let leavingUserId = userId || socket.data.userId;
      let leavingRoomId = roomId || socket.data.roomId;
      let leavingUsername = username;
      if(!leavingUsername && leavingUserId){
        leavingUsername = await getUsernameById(leavingUserId);
      }
      if(leavingRoomId && leavingUserId){
        // Xoa khoi room_players
        await supabase.from('room_players').delete().eq('room_id', leavingRoomId).eq('user_id', leavingUserId);
        // Thong bao cho phong
        io.to(leavingRoomId).emit('player-left', {userId: leavingUserId, username: leavingUsername || 'Người chơi', roomId: leavingRoomId});
        const {data: remainingPlayers} = await supabase.from('room_players').select('*').eq('room_id', leavingRoomId);
        io.to(leavingRoomId).emit('players-update', remainingPlayers);

        // Kiem tra neu dang choi ma chi con 1 nguoi -> auto win
        const game = activeGames.get(leavingRoomId);
        if(game && game.players){
          const stillInRoom = remainingPlayers.filter(p=>!p.is_bot);
          // Chi con 1 nguoi that
          if(stillInRoom.length === 1 && game.roomData && game.roomData.status !== 'finished'){
            console.log(`Only 1 player left in room ${leavingRoomId}, auto win for ${stillInRoom[0].user_id}`);
            clearInterval(game.interval);
            activeGames.delete(leavingRoomId);
            const bet = game.roomData.bet_amount;
            const feePercent = game.roomData.fee_percent;
            const originalCount = game.originalPlayers ? game.originalPlayers.length : (remainingPlayers.length + 1);
            const totalPot = originalCount * bet;
            const fee = Math.floor(totalPot * feePercent / 100);
            const winAmount = totalPot - fee;
            const winner = stillInRoom[0];
            // Tru tien nguoi out (da out roi nhung van tru de cong vao pot)
            // Trong truong hop nay, nguoi out da bi xoa khoi room_players, nhung ta van tru balance cua ho dua tren originalPlayers
            for(const pl of game.originalPlayers){
              if(pl.user_id && pl.user_id !== winner.user_id){
                const {data: prof} = await supabase.from('profiles').select('balance').eq('id',pl.user_id).single();
                if(prof){
                  // Chi tru neu chua tru
                  await supabase.from('profiles').update({balance: prof.balance - bet}).eq('id',pl.user_id);
                }
              }
            }
            const {data: winnerProf} = await supabase.from('profiles').select('balance').eq('id',winner.user_id).single();
            if(winnerProf){
              await supabase.from('profiles').update({balance: winnerProf.balance + winAmount}).eq('id',winner.user_id);
            }
            await supabase.from('transactions').insert([{user_id: winner.user_id, type:'win', amount: winAmount, room_id:leavingRoomId}]);
            await supabase.from('rooms').update({status:'finished', winner_id: winner.user_id}).eq('id',leavingRoomId);
            io.to(leavingRoomId).emit('game-won', {winner: winner, winAmount, fee, totalPot, reason:'last_man_standing', leftCount: originalCount -1});
            io.to(leavingRoomId).emit('toast', {message: `Người chơi cuối cùng ${winner.username || 'Bạn'} thắng vì mọi người đã rời phòng!`, type:'success'});
          }
        }
      }
    }catch(e){ console.log('leave-room error', e.message); }
  });

  socket.on('disconnect', async ()=>{
    try{
      const userId = socket.data.userId;
      const roomId = socket.data.roomId;
      if(userId && roomId){
        // Xu ly nhu leave-room
        const username = await getUsernameById(userId);
        await supabase.from('room_players').delete().eq('room_id', roomId).eq('user_id', userId);
        io.to(roomId).emit('player-left', {userId, username: username || 'Người chơi', roomId});
        const {data: remainingPlayers} = await supabase.from('room_players').select('*').eq('room_id', roomId);
        io.to(roomId).emit('players-update', remainingPlayers);
        const game = activeGames.get(roomId);
        if(game){
          const stillInRoom = remainingPlayers.filter(p=>!p.is_bot);
          if(stillInRoom.length === 1 && game.roomData && game.roomData.status !== 'finished'){
            clearInterval(game.interval);
            activeGames.delete(roomId);
            const bet = game.roomData.bet_amount;
            const feePercent = game.roomData.fee_percent;
            const originalCount = game.originalPlayers ? game.originalPlayers.length : (remainingPlayers.length + 1);
            const totalPot = originalCount * bet;
            const fee = Math.floor(totalPot * feePercent / 100);
            const winAmount = totalPot - fee;
            const winner = stillInRoom[0];
            for(const pl of game.originalPlayers){
              if(pl.user_id && pl.user_id !== winner.user_id){
                const {data: prof} = await supabase.from('profiles').select('balance').eq('id',pl.user_id).single();
                if(prof) await supabase.from('profiles').update({balance: prof.balance - bet}).eq('id',pl.user_id);
              }
            }
            const {data: winnerProf} = await supabase.from('profiles').select('balance').eq('id',winner.user_id).single();
            if(winnerProf) await supabase.from('profiles').update({balance: winnerProf.balance + winAmount}).eq('id',winner.user_id);
            await supabase.from('transactions').insert([{user_id: winner.user_id, type:'win', amount: winAmount, room_id:roomId}]);
            await supabase.from('rooms').update({status:'finished', winner_id: winner.user_id}).eq('id',roomId);
            io.to(roomId).emit('game-won', {winner, winAmount, fee, totalPot, reason:'last_man_standing'});
          }
        }
      }
    }catch(e){ console.log('disconnect error', e.message); }
  });

});

app.get('/', (req,res)=> res.send('Loto Online Backend Running - Fixed Audio Sync & Auto Win'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Server running on '+PORT));
