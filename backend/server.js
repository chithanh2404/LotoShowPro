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
const DEPOSIT_BANK_INFO = {
  bank: 'BIDV',
  account: '96247DV7M8',
  holder: 'VU TRUNG THANH'
};
const DEPOSIT_BANK = DEPOSIT_BANK_INFO;

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

async function getProfileById(userId){
  try{
    const {data: profile} = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
    return profile;
  }catch(e){ return null; }
}

// ===== UTILS: Tạo vé Loto chuẩn Việt Nam =====
function generateLotoTicket() {
  const ticket = Array(3).fill(0).map(()=> Array(9).fill(null));
  const rowCounts = [0,0,0];
  
  for(let c=0;c<9;c++){
    let available = [0,1,2].filter(r=> rowCounts[r] < 5);
    available.sort((a,b)=> rowCounts[a]-rowCounts[b]);
    let minCount = rowCounts[available[0]];
    let candidates = available.filter(r=> rowCounts[r]===minCount);
    const r = candidates[Math.floor(Math.random()*candidates.length)];
    ticket[r][c] = getRandomInCol(c);
    rowCounts[r]++;
  }
  
  for(let r=0;r<3;r++){
    let needed = 5 - rowCounts[r];
    let attempts = 0;
    while(needed > 0 && attempts < 100){
      const c = Math.floor(Math.random()*9);
      if(ticket[r][c]===null){
        const colCount = (ticket[0][c]!==null?1:0)+(ticket[1][c]!==null?1:0)+(ticket[2][c]!==null?1:0);
        if(colCount >= 3){ attempts++; continue; }
        let val;
        let tries=0;
        do{
          val = getRandomInCol(c);
          tries++;
        }while(columnHas(ticket,val,c) && tries<30);
        ticket[r][c]=val;
        rowCounts[r]++;
        needed--;
      }
      attempts++;
    }
  }
  
  for(let c=0;c<9;c++){
    const vals = [];
    for(let r=0;r<3;r++) if(ticket[r][c]!==null) vals.push(ticket[r][c]);
    vals.sort((a,b)=>a-b);
    let idx=0;
    for(let r=0;r<3;r++) if(ticket[r][c]!==null) ticket[r][c]=vals[idx++];
  }
  
  for(let r=0;r<3;r++){
    const count = ticket[r].filter(v=>v!==null).length;
    if(count !== 5){
      return generateLotoTicket();
    }
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
  if(!ticket || !drawnSet) return false;
  for(let r=0;r<3;r++){
    const row = ticket[r];
    if(!row) continue;
    const rowNums = row.filter(v=> v!==null && v!==undefined);
    // FIX: phải đủ 5 số mới tính thắng, tránh vé lỗi báo ảo
    if(rowNums.length !== 5) continue;
    if(rowNums.every(n=>drawnSet.has(n))) return true;
  }
  return false;
}
function getWinningRowInfo(ticket, drawnSet){
  if(!ticket || !drawnSet) return null;
  for(let r=0;r<3;r++){
    const row = ticket[r];
    if(!row) continue;
    const rowNums = row.filter(v=> v!==null && v!==undefined);
    if(rowNums.length !== 5) continue;
    if(rowNums.every(n=>drawnSet.has(n))){
      return { row: r, numbers: rowNums };
    }
  }
  return null;
}

function getAudioVariantForNumber(num, drawIndex, roomId){
  const maxVariants = 3;
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

// ===== NEW: Profile APIs =====
app.get('/api/profile/:userId', async (req,res)=>{
  try{
    const {userId} = req.params;
    const profile = await getProfileById(userId);
    if(!profile) return res.status(404).json({error:'Profile not found'});
    // Ensure demo_balance exists
    const demo_balance = profile.demo_balance !== undefined ? profile.demo_balance : 100000;
    const balance = profile.balance || 0;
    const total_deposited = profile.total_deposited || 0;
    const total_wagered = profile.total_wagered || 0;
    const role = profile.role || 'user';
    res.json({...profile, demo_balance, balance, total_deposited, total_wagered, role, total_balance: balance + demo_balance});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/profile/bank', async (req,res)=>{
  try{
    const {userId, bank_name, bank_account, account_holder} = req.body;
    if(!userId) return res.status(400).json({error:'Missing userId'});
    if(!bank_name || !bank_account || !account_holder) return res.status(400).json({error:'Thiếu thông tin ngân hàng'});
    const {data, error} = await supabase.from('profiles').update({bank_name, bank_account, account_holder, bank_updated_at: new Date().toISOString()}).eq('id', userId).select().single();
    if(error) return res.status(500).json({error:error.message});
    res.json({ok:true, profile:data});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/profile/change-password', async (req,res)=>{
  try{
    const {userId, newPassword} = req.body;
    if(!userId || !newPassword) return res.status(400).json({error:'Missing params'});
    if(newPassword.length < 6) return res.status(400).json({error:'Mật khẩu phải >=6 ký tự'});
    const {error} = await supabase.auth.admin.updateUserById(userId, {password: newPassword});
    if(error) return res.status(500).json({error:error.message});
    res.json({ok:true, message:'Đổi mật khẩu thành công'});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ===== NEW: Withdrawal APIs =====
app.post('/api/withdrawals/request', async (req,res)=>{
  try{
    const {userId, amount, bank_name, bank_account, account_holder} = req.body;
    if(!userId || !amount) return res.status(400).json({error:'Thiếu thông tin'});
    const amt = parseInt(amount);
    if(amt < 50000) return res.status(400).json({error:'Số tiền rút tối thiểu 50,000 xu'});
    
    const profile = await getProfileById(userId);
    if(!profile) return res.status(404).json({error:'User not found'});
    if(profile.is_banned) return res.status(403).json({error:'Tài khoản bị khóa, không thể rút tiền'});
    
    const realBalance = profile.balance || 0;
    const totalDeposited = profile.total_deposited || 0;
    const totalWagered = profile.total_wagered || 0;
    
    if(realBalance < amt) return res.status(400).json({error:`Số dư thật không đủ. Bạn có ${realBalance.toLocaleString()} xu thật`});
    
    // Wager requirement: must wager at least total_deposited
    if(totalDeposited > 0 && totalWagered < totalDeposited){
      const need = totalDeposited - totalWagered;
      return res.status(400).json({error:`Bạn cần cược thêm ${need.toLocaleString()} xu nữa mới được rút. Đã cược ${totalWagered.toLocaleString()}/${totalDeposited.toLocaleString()}`, need, totalWagered, totalDeposited});
    }
    
    // Use provided bank or profile bank
    const finalBankName = bank_name || profile.bank_name;
    const finalBankAccount = bank_account || profile.bank_account;
    const finalAccountHolder = account_holder || profile.account_holder;
    
    if(!finalBankName || !finalBankAccount || !finalAccountHolder){
      return res.status(400).json({error:'Vui lòng cập nhật thông tin ngân hàng trước khi rút'});
    }
    
    // Create withdrawal
    const {data, error} = await supabase.from('withdrawals').insert({
      user_id: userId,
      amount: amt,
      bank_name: finalBankName,
      bank_account: finalBankAccount,
      account_holder: finalAccountHolder,
      status: 'pending'
    }).select().single();
    
    if(error) return res.status(500).json({error:error.message});
    
    res.json({ok:true, withdrawal:data, message:'Đã tạo lệnh rút tiền, vui lòng chờ admin duyệt'});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/withdrawals/my/:userId', async (req,res)=>{
  try{
    const {userId} = req.params;
    const {data, error} = await supabase.from('withdrawals').select('*').eq('user_id', userId).order('created_at', {ascending:false});
    if(error) return res.status(500).json({error:error.message});
    res.json(data || []);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/withdrawals/all', async (req,res)=>{
  try{
    const {userId} = req.query;
    if(!userId) return res.status(400).json({error:'Missing userId'});
    const profile = await getProfileById(userId);
    if(!profile || profile.role !== 'admin') return res.status(403).json({error:'Không có quyền admin'});
    
    const {data, error} = await supabase.from('withdrawals').select('*, profiles!withdrawals_user_id_fkey(username, email)').order('created_at', {ascending:false});
    if(error) return res.status(500).json({error:error.message});
    res.json(data || []);
  }catch(e){ res.status(500).json({error:e.message}); }
});

// ===== NEW: Admin APIs =====
function isAdmin(profile){
  return profile && profile.role === 'admin';
}

app.get('/api/admin/users', async (req,res)=>{
  try{
    const {adminId} = req.query;
    const adminProfile = await getProfileById(adminId);
    if(!isAdmin(adminProfile)) return res.status(403).json({error:'Forbidden'});
    
    const {data, error} = await supabase.from('profiles').select('*').order('created_at', {ascending:false}).limit(100);
    if(error) return res.status(500).json({error:error.message});
    res.json(data || []);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/withdrawals', async (req,res)=>{
  try{
    const {adminId, status} = req.query;
    const adminProfile = await getProfileById(adminId);
    if(!isAdmin(adminProfile)) return res.status(403).json({error:'Forbidden'});
    
    let query = supabase.from('withdrawals').select('*, profiles!withdrawals_user_id_fkey(username, email, balance, demo_balance)').order('created_at', {ascending:false});
    if(status) query = query.eq('status', status);
    const {data, error} = await query;
    if(error) return res.status(500).json({error:error.message});
    res.json(data || []);
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/approve', async (req,res)=>{
  try{
    const {id} = req.params;
    const {adminId, note} = req.body;
    const adminProfile = await getProfileById(adminId);
    if(!isAdmin(adminProfile)) return res.status(403).json({error:'Forbidden'});
    
    const {data: wd} = await supabase.from('withdrawals').select('*, profiles!withdrawals_user_id_fkey(balance)').eq('id', id).single();
    if(!wd) return res.status(404).json({error:'Withdrawal not found'});
    if(wd.status !== 'pending') return res.status(400).json({error:'Lệnh đã được xử lý'});
    
    const profile = await getProfileById(wd.user_id);
    if(!profile) return res.status(404).json({error:'User not found'});
    if((profile.balance || 0) < wd.amount) return res.status(400).json({error:'User không đủ số dư thật'});
    
    // Deduct real balance
    const newBalance = (profile.balance || 0) - wd.amount;
    const newTotalWithdrawn = (profile.total_withdrawn || 0) + wd.amount;
    await supabase.from('profiles').update({balance: newBalance, total_withdrawn: newTotalWithdrawn}).eq('id', wd.user_id);
    
    // Update withdrawal
    const {data, error} = await supabase.from('withdrawals').update({status:'approved', processed_at: new Date().toISOString(), admin_id: adminId, admin_note: note || 'Đã duyệt'}).eq('id', id).select().single();
    if(error) return res.status(500).json({error:error.message});
    
    await supabase.from('transactions').insert([{user_id: wd.user_id, type:'withdraw', amount: -wd.amount, description: `Rút tiền ${wd.amount} về ${wd.bank_name} ${wd.bank_account}`}]);
    
    res.json({ok:true, withdrawal:data});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/withdrawals/:id/reject', async (req,res)=>{
  try{
    const {id} = req.params;
    const {adminId, note} = req.body;
    const adminProfile = await getProfileById(adminId);
    if(!isAdmin(adminProfile)) return res.status(403).json({error:'Forbidden'});
    
    const {data, error} = await supabase.from('withdrawals').update({status:'rejected', processed_at: new Date().toISOString(), admin_id: adminId, admin_note: note || 'Bị từ chối'}).eq('id', id).select().single();
    if(error) return res.status(500).json({error:error.message});
    res.json({ok:true, withdrawal:data});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:id/ban', async (req,res)=>{
  try{
    const {id} = req.params;
    const {adminId, reason} = req.body;
    const adminProfile = await getProfileById(adminId);
    if(!isAdmin(adminProfile)) return res.status(403).json({error:'Forbidden'});
    
    const {data, error} = await supabase.from('profiles').update({is_banned:true, banned_reason: reason || 'Vi phạm', banned_at: new Date().toISOString(), banned_by: adminId}).eq('id', id).select().single();
    if(error) return res.status(500).json({error:error.message});
    res.json({ok:true, user:data});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/admin/users/:id/unban', async (req,res)=>{
  try{
    const {id} = req.params;
    const {adminId} = req.body;
    const adminProfile = await getProfileById(adminId);
    if(!isAdmin(adminProfile)) return res.status(403).json({error:'Forbidden'});
    
    const {data, error} = await supabase.from('profiles').update({is_banned:false, banned_reason:null, banned_at:null}).eq('id', id).select().single();
    if(error) return res.status(500).json({error:error.message});
    res.json({ok:true, user:data});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/stats', async (req,res)=>{
  try{
    const {adminId} = req.query;
    const adminProfile = await getProfileById(adminId);
    if(!isAdmin(adminProfile)) return res.status(403).json({error:'Forbidden'});
    
    let winStats = null;
    let loseStats = null;
    try{
      const {data: winnersView} = await supabase.from('admin_top_winners').select('*').limit(20);
      if(winnersView && winnersView.length>0) winStats = winnersView;
    }catch(e){ console.log('admin_top_winners view error', e.message); }
    
    try{
      const {data: losersView} = await supabase.from('admin_top_losers').select('*').limit(20);
      if(losersView && losersView.length>0) loseStats = losersView;
    }catch(e){ console.log('admin_top_losers view error', e.message); }
    
    if(!winStats){
      const {data} = await supabase.from('transactions').select('user_id, amount').eq('type','win');
      if(data){
        const grouped = {};
        data.forEach(t=>{
          if(!grouped[t.user_id]) grouped[t.user_id]={user_id:t.user_id, amount:0, count:0};
          grouped[t.user_id].amount += t.amount;
          grouped[t.user_id].count++;
        });
        winStats = Object.values(grouped).sort((a,b)=>b.amount-a.amount).slice(0,20);
        for(let w of winStats){
          const prof = await getProfileById(w.user_id);
          w.profiles = {username: prof ? (prof.username||prof.email) : w.user_id.slice(0,8)};
          w.total_win = w.amount;
          w.win_count = w.count;
        }
      }
    }
    
    if(!loseStats){
      const {data} = await supabase.from('transactions').select('user_id, amount').eq('type','lose');
      if(data){
        const grouped = {};
        data.forEach(t=>{
          if(!grouped[t.user_id]) grouped[t.user_id]={user_id:t.user_id, amount:0, count:0};
          grouped[t.user_id].amount += Math.abs(t.amount);
          grouped[t.user_id].count++;
        });
        loseStats = Object.values(grouped).sort((a,b)=>b.amount-a.amount).slice(0,20);
        for(let l of loseStats){
          const prof = await getProfileById(l.user_id);
          l.profiles = {username: prof ? (prof.username||prof.email) : l.user_id.slice(0,8)};
          l.total_lose = l.amount;
          l.lose_count = l.count;
        }
      }
    }
    
    let withdrawStats = [];
    try{
      const {data} = await supabase.from('withdrawals').select('user_id, amount, profiles!withdrawals_user_id_fkey(username)').eq('status','approved').order('amount', {ascending:false}).limit(20);
      withdrawStats = data || [];
    }catch(e){
      const {data} = await supabase.from('withdrawals').select('user_id, amount').eq('status','approved');
      if(data){
        const grouped = {};
        data.forEach(t=>{
          if(!grouped[t.user_id]) grouped[t.user_id]={user_id:t.user_id, amount:0};
          grouped[t.user_id].amount += t.amount;
        });
        withdrawStats = Object.values(grouped).sort((a,b)=>b.amount-a.amount).slice(0,20);
        for(let w of withdrawStats){
          const prof = await getProfileById(w.user_id);
          w.profiles = {username: prof ? (prof.username||prof.email) : w.user_id.slice(0,8)};
        }
      }
    }
    
    res.json({topWinners: winStats || [], topLosers: loseStats || [], topWithdrawals: withdrawStats || []});
  }catch(e){ console.log('stats error', e); res.status(500).json({error:e.message}); }
});


app.get('/api/admin/transactions/:userId', async (req,res)=>{
  try{
    const {userId} = req.params;
    const {adminId} = req.query;
    const adminProfile = await getProfileById(adminId);
    if(!isAdmin(adminProfile)) return res.status(403).json({error:'Forbidden'});
    
    const {data, error} = await supabase.from('transactions').select('*').eq('user_id', userId).order('created_at', {ascending:false}).limit(50);
    if(error) return res.status(500).json({error:error.message});
    res.json(data || []);
  }catch(e){ res.status(500).json({error:e.message}); }
});

function generateTransferContent(userId){
  // NAP + 4 ky tu cuoi userId + 4 ky tu random
  const shortId = userId ? userId.toString().slice(-4).toUpperCase() : 'XXXX';
  const random = nanoid(4).toUpperCase();
  return `NAP${shortId}${random}`;
}

// API: Tao lenh nap tien
app.post('/api/deposit/create', async (req, res) => {
  try{
    const { userId, amount } = req.body;
    if(!userId) return res.status(400).json({error: 'Thieu userId'});
    const amt = parseInt(amount);
    if(!amt || amt < 10000) return res.status(400).json({error: 'So tien toi thieu 10,000 VND'});
    if(amt > 50000000) return res.status(400).json({error: 'So tien toi da 50,000,000 VND'});

    const transferContent = generateTransferContent(userId);
    const depositId = 'DEP-' + nanoid(8).toUpperCase();
    
    // Luu vao DB - bang deposits
    const { data, error } = await supabase.from('deposits').insert({
      id: depositId,
      user_id: userId,
      amount: amt,
      transfer_content: transferContent,
      transfer_content_lower: transferContent.toLowerCase(),
      status: 'pending',
      bank: DEPOSIT_BANK_INFO.bank,
      account_number: DEPOSIT_BANK_INFO.account,
      account_holder: DEPOSIT_BANK_INFO.holder
    }).select().single();

    if(error){
      console.log('Deposit create error:', error.message);
      // Neu bang chua ton tai, thu tao bang tam thoi bang cach return truc tiep
      // Van tra ve thong tin de frontend hien thi
      return res.json({
        id: depositId,
        userId,
        amount: amt,
        transferContent,
        bank: DEPOSIT_BANK_INFO.bank,
        account: DEPOSIT_BANK_INFO.account,
        holder: DEPOSIT_BANK_INFO.holder,
        qrUrl: `https://qr.sepay.vn/img?bank=BIDV&acc=${DEPOSIT_BANK_INFO.account}&template=compact&amount=${amt}&des=${encodeURIComponent(transferContent)}`,
        vietQrUrl: `https://img.vietqr.io/image/BIDV-${DEPOSIT_BANK_INFO.account}-qr_only.png?amount=${amt}&addInfo=${encodeURIComponent(transferContent)}&accountName=${encodeURIComponent(DEPOSIT_BANK_INFO.holder)}`,
        status: 'pending',
        note: 'Bang deposits chua ton tai, vui long chay SQL tao bang'
      });
    }

    res.json({
      id: data.id,
      userId,
      amount: data.amount,
      transferContent: data.transfer_content,
      bank: data.bank,
      account: data.account_number,
      holder: data.account_holder,
      qrUrl: `https://qr.sepay.vn/img?bank=BIDV&acc=${DEPOSIT_BANK_INFO.account}&template=compact&amount=${amt}&des=${encodeURIComponent(transferContent)}`,
      vietQrUrl: `https://img.vietqr.io/image/BIDV-${DEPOSIT_BANK_INFO.account}-qr_only.png?amount=${amt}&addInfo=${encodeURIComponent(transferContent)}&accountName=${encodeURIComponent(DEPOSIT_BANK_INFO.holder)}`,
      status: data.status,
      created_at: data.created_at
    });
  }catch(e){
    console.error('Deposit create error:', e);
    res.status(500).json({error: e.message});
  }
});

// API: Kiem tra trang thai lenh nap
app.get('/api/deposit/status/:id', async (req, res) => {
  try{
    const { id } = req.params;
    const { data, error } = await supabase.from('deposits').select('*').eq('id', id).single();
    if(error || !data) return res.status(404).json({error: 'Khong tim thay lenh nap'});
    res.json(data);
  }catch(e){ res.status(500).json({error: e.message}); }
});

// API: Lich su nap tien
app.get('/api/deposit/history', async (req, res) => {
  try{
    const userId = req.query.userId;
    if(!userId) return res.status(400).json({error: 'Thieu userId'});
    const { data, error } = await supabase.from('deposits').select('*').eq('user_id', userId).order('created_at', {ascending: false}).limit(20);
    if(error) return res.json([]);
    res.json(data);
  }catch(e){ res.status(500).json({error: e.message}); }
});

// API: Lay so du user
app.get('/api/user/balance', async (req, res) => {
  try{
    const userId = req.query.userId;
    if(!userId) return res.status(400).json({error: 'Thieu userId'});
    const { data, error } = await supabase.from('profiles').select('balance').eq('id', userId).single();
    if(error) return res.status(404).json({error: 'User not found'});
    res.json({ balance: data.balance || 0 });
  }catch(e){ res.status(500).json({error: e.message}); }
});

// API: Webhook Sepay - Tu dong duyet khi chuyen khoan thanh cong
// Sepay se gui POST den https://lotoshowpro.onrender.com/api/sepay/webhook
// Cau hinh trong Sepay dashboard: Webhook URL = https://lotoshowpro.onrender.com/api/sepay/webhook
app.post('/api/sepay/webhook', async (req, res) => {
  try{
    const payload = req.body;
    console.log('Sepay webhook received:', JSON.stringify(payload).slice(0, 1000));

    // Sepay co the gui 1 object hoac array, hoac co wrapper { data: {...} }
    let transaction = payload;
    if(payload.data) transaction = payload.data;
    if(Array.isArray(transaction)) transaction = transaction[0];

    // Lay thong tin giao dich
    const content = (transaction.content || transaction.description || transaction.transferContent || '').toString();
    const amount = parseInt(transaction.transferAmount || transaction.amount || transaction.transfer_amount || 0);
    const accountNumber = (transaction.accountNumber || transaction.account_number || '').toString();
    const transactionId = (transaction.id || transaction.referenceCode || transaction.reference_code || '').toString();
    const gateway = (transaction.gateway || transaction.bank || '').toString();

    if(!content || !amount){
      console.log('Webhook missing content or amount');
      return res.json({ success: false, message: 'Missing content or amount' });
    }

    // Chi xu ly giao dich vao (in) va dung tai khoan BIDV cua chung ta
    // Neu co nhieu tai khoan, kiem tra accountNumber
    if(accountNumber && accountNumber !== DEPOSIT_BANK_INFO.account && !accountNumber.includes(DEPOSIT_BANK_INFO.account)){
      console.log('Webhook account mismatch:', accountNumber);
      // Van tiep tuc xu ly neu content khop, de tranh truong hop Sepay gui accountNumber khac format
    }

    // Tim lenh nap dang pending co transfer_content nam trong content chuyen khoan
    // Vi du: content = "NAPABCD1234 chuyen tien" -> tim NAPABCD1234
    const contentLower = content.toLowerCase();
    
    // Lay tat ca lenh pending
    const { data: pendingDeposits, error } = await supabase.from('deposits').select('*').eq('status', 'pending').order('created_at', {ascending: false}).limit(50);
    
    if(error){
      console.log('Fetch pending deposits error:', error.message);
      return res.status(500).json({ success: false, error: error.message });
    }

    let matchedDeposit = null;
    for(const dep of pendingDeposits || []){
      const transferContentLower = (dep.transfer_content_lower || dep.transfer_content || '').toLowerCase();
      if(transferContentLower && contentLower.includes(transferContentLower)){
        matchedDeposit = dep;
        break;
      }
      // Thu tim theo id ngan gon neu content co chua id
      if(dep.id && contentLower.includes(dep.id.toLowerCase().slice(-6))){
        matchedDeposit = dep;
        break;
      }
    }

    // Neu khong tim thay theo content, thu parse content kieu NAPxxxx
    if(!matchedDeposit){
      const napMatch = content.match(/NAP[A-Z0-9]{4,12}/i);
      if(napMatch){
        const code = napMatch[0];
        const { data: depByCode } = await supabase.from('deposits').select('*').ilike('transfer_content', `%${code}%`).eq('status', 'pending').maybeSingle();
        if(depByCode) matchedDeposit = depByCode;
      }
    }

    if(!matchedDeposit){
      console.log('No matching deposit found for content:', content);
      return res.json({ success: true, message: 'No matching deposit, but webhook received', content, amount });
    }

    // Kiem tra so tien - cho phep chenh lech nho (do phi) hoac phai bang hoac lon hon
    if(amount < matchedDeposit.amount){
      console.log(`Amount mismatch: received ${amount} < expected ${matchedDeposit.amount} for ${matchedDeposit.id}`);
      // Van co the chap nhan neu amount >= 90% expected? Tam thoi yeu cau dung so tien
      // return res.json({ success: false, message: `Amount ${amount} less than expected ${matchedDeposit.amount}` });
    }

    // Cong tien cho user + cap nhat total_deposited
    const { data: profile } = await supabase.from('profiles').select('balance, total_deposited').eq('id', matchedDeposit.user_id).single();
    const currentBalance = profile ? (profile.balance || 0) : 0;
    const currentDeposited = profile ? (profile.total_deposited || 0) : 0;
    const newBalance = currentBalance + matchedDeposit.amount;
    const newDeposited = currentDeposited + matchedDeposit.amount;

    await supabase.from('profiles').update({ balance: newBalance, total_deposited: newDeposited }).eq('id', matchedDeposit.user_id);

    // Cap nhat trang thai deposit
    await supabase.from('deposits').update({
      status: 'success',
      sepay_transaction_id: transactionId,
      sepay_data: transaction,
      confirmed_at: new Date().toISOString(),
      received_amount: amount,
      received_content: content
    }).eq('id', matchedDeposit.id);

    // Ghi transaction
    await supabase.from('transactions').insert([{
      user_id: matchedDeposit.user_id,
      type: 'deposit',
      amount: matchedDeposit.amount,
      room_id: null,
      description: `Nap tien ${matchedDeposit.amount} VND - ${matchedDeposit.transfer_content} - Sepay ${transactionId}`
    }]);

    console.log(`Deposit success: ${matchedDeposit.id} for user ${matchedDeposit.user_id} +${matchedDeposit.amount} - new balance ${newBalance}`);

    res.json({ success: true, message: 'Deposit confirmed', depositId: matchedDeposit.id, newBalance });
  }catch(e){
    console.error('Sepay webhook error:', e);
    res.status(500).json({ success: false, error: e.message });
  }
});

// API: Test webhook manual (de test)
app.post('/api/deposit/manual-confirm', async (req, res) => {
  try{
    const { depositId, secret } = req.body;
    // Simple secret check - ban co the doi
    if(secret !== 'loto123') return res.status(403).json({error: 'Invalid secret'});
    const { data: dep } = await supabase.from('deposits').select('*').eq('id', depositId).single();
    if(!dep) return res.status(404).json({error: 'Deposit not found'});
    if(dep.status === 'success') return res.json({message: 'Already success', deposit: dep});

    const { data: profile } = await supabase.from('profiles').select('balance, total_deposited').eq('id', dep.user_id).single();
    const newBalance = (profile.balance || 0) + dep.amount;
    const newDeposited = (profile.total_deposited || 0) + dep.amount;
    await supabase.from('profiles').update({ balance: newBalance, total_deposited: newDeposited }).eq('id', dep.user_id);
    await supabase.from('deposits').update({ status: 'success', confirmed_at: new Date().toISOString() }).eq('id', dep.id);
    await supabase.from('transactions').insert([{ user_id: dep.user_id, type: 'deposit', amount: dep.amount, description: `Manual confirm ${dep.transfer_content}` }]);
    res.json({ success: true, newBalance, deposit: dep });
  }catch(e){ res.status(500).json({error: e.message}); }
});




app.get('/api/tickets/generate', (req,res)=>{
  const count = parseInt(req.query.count||'6');
  const colors = ['#00d2ff','#FFD700','#ff007f','#39ff14','#ff6b35','#9c27b0','#00bcd4','#e91e63'];
  const tickets = Array(count).fill(0).map((_,i)=> ({
    ticket: generateLotoTicket(),
    color: colors[i % colors.length],
    colorIndex: i % colors.length
  }));
  res.json({tickets});
});

app.post('/api/rooms', async (req,res)=>{
  const {hostId, name, password, betAmount, maxPlayers, ticket, isDemo} = req.body;
  const id = 'LOTO-'+nanoid(6).toUpperCase();
  const fee = 20;
  const {data, error} = await supabase.from('rooms').insert({id, name, host_id:hostId, password: password||null, bet_amount:betAmount, max_players:maxPlayers||10, fee_percent:fee, status:'waiting'}).select().single();
  if(error) return res.status(500).json({error});
  const finalTicket = ticket || generateLotoTicket();
  const username = await getUsernameById(hostId);
  const ticketColor = req.body.ticketColor || '#00d2ff';
  const is_demo = !!isDemo;
  await supabase.from('room_players').insert({room_id:id, user_id:hostId, username: username, ticket: finalTicket, ticket_color: ticketColor, is_bot:false, is_demo});
  // Cache host
  roomHosts.set(id, hostId);
  roomReadyStates.set(id, new Map());
  res.json(data);
});

app.get('/api/rooms', async (req,res)=>{
  try{
    const {data: rooms, error} = await supabase.from('rooms').select('*').order('created_at', {ascending:false}).limit(100);
    if(error) return res.status(500).json({error: error.message});
    
    // Lọc phòng đang hoạt động (chưa finished hoặc finished trong 5 phút gần đây để vẫn hiện)
    const now = new Date();
    const activeRooms = [];
    
    for(const room of rooms || []){
      // Bỏ phòng SOLO? Giữ lại phòng riêng thôi, bỏ SOLO khỏi danh sách chung
      if(room.id && room.id.startsWith('SOLO-')) continue;
      // Chỉ lấy phòng chưa finished hoặc mới finished
      if(room.status === 'finished'){
        const updatedAt = room.updated_at ? new Date(room.updated_at) : new Date(room.created_at);
        const diffMinutes = (now - updatedAt) / 1000 / 60;
        if(diffMinutes > 10) continue; // bỏ phòng finished quá 10 phút
      }
      
      // Lấy số người chơi
      const {data: players} = await supabase.from('room_players').select('user_id, is_bot').eq('room_id', room.id);
      const realPlayers = players ? players.filter(p=>!p.is_bot) : [];
      const totalPlayers = players ? players.length : 0;

      // ===== FIX: CHỈ GIỮ PHÒNG CÓ NGƯỜI THẬT - XÓA PHÒNG TRỐNG =====
      // Nếu không có ai cả -> xóa luôn khỏi DB và bỏ qua
      if(totalPlayers === 0){
        // Xóa phòng rác khỏi DB (không block luồng chính)
        supabase.from('rooms').delete().eq('id', room.id).then(()=> {
          console.log(`[CLEANUP-GET] Xóa phòng trống ${room.id} (0 players)`);
        }).catch(()=>{});
        continue;
      }
      // Nếu chỉ toàn bot mà không có người thật -> không hiện trong danh sách chung
      if(realPlayers.length === 0){
        continue;
      }
      
      // Lấy tiến trình từ activeGames
      let drawnCount = 0;
      let progress = 0;
      let isPlaying = false;
      const game = activeGames.get(room.id);
      if(game){
        drawnCount = game.drawn ? game.drawn.length : 0;
        progress = Math.round((drawnCount / 90) * 100);
        isPlaying = !!game.isDrawing;
      } else {
        // Nếu không có trong activeGames, thử lấy từ rooms.current_numbers nếu có
        if(room.current_numbers && Array.isArray(room.current_numbers)){
          drawnCount = room.current_numbers.length;
          progress = Math.round((drawnCount / 90) * 100);
        }
      }
      
      activeRooms.push({
        id: room.id,
        name: room.name || 'Phòng '+room.id,
        hasPassword: !!(room.password),
        has_password: !!(room.password),
        playerCount: realPlayers.length,
        realPlayersCount: realPlayers.length,
        totalPlayers: totalPlayers,
        maxPlayers: 10, // ép tất cả phòng lên 10 người
        bet_amount: room.bet_amount || room.bet || 0,
        fee: room.fee_percent || room.fee || 20,
        status: room.status || 'waiting',
        drawnCount: drawnCount,
        progress: progress,
        isPlaying: isPlaying,
        created_at: room.created_at,
        host_id: room.host_id
      });
    }
    
    // Sắp xếp: đang chơi lên đầu, rồi theo số người
    activeRooms.sort((a,b)=>{
      if(a.isPlaying && !b.isPlaying) return -1;
      if(!a.isPlaying && b.isPlaying) return 1;
      return b.playerCount - a.playerCount;
    });
    
    res.json({rooms: activeRooms, count: activeRooms.length});
  }catch(e){
    console.log('get active rooms error', e.message);
    res.status(500).json({error: e.message});
  }
});

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

app.get('/api/rooms/:roomId', async (req,res)=>{
  const {roomId} = req.params;
  try{
    const {data: room, error} = await supabase.from('rooms').select('*').eq('id', roomId).single();
    if(error) return res.status(404).json({error: 'Phong khong ton tai'});
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id', roomId);
    const hasBots = players ? players.some(p=>p.is_bot) : false;
    const realPlayers = players ? players.filter(p=>!p.is_bot) : [];
    const game = activeGames.get(roomId);
    const isPlaying = room.status === 'playing' || (game && game.isDrawing);
    // ==== NEW: return hostId, status, isPlaying, ready states ====
    const readyMap = roomReadyStates.get(roomId);
    const playersWithReady = (players || []).map(p=>{
      const isReady = readyMap ? !!readyMap.get(p.user_id) : false;
      return {...p, isReady};
    });
    res.json({
      ...room, 
      players: playersWithReady, 
      hasBots, 
      realPlayersCount: realPlayers.length, 
      totalPlayers: players ? players.length : 0,
      hostId: room.host_id || roomHosts.get(roomId) || null,
      host_id: room.host_id || roomHosts.get(roomId) || null,
      status: room.status,
      isPlaying,
      audioMode: roomAudioModes.get(roomId) || room.audio_mode || 'MUSIC'
    });
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// ===== SOCKET.IO GAME LOOP =====
const activeGames = new Map();
const roomAudioModes = new Map(); // audio mode sync
const roomReadyStates = new Map(); // roomId -> Map(userId -> isReady)
const roomHosts = new Map(); // roomId -> hostId cache
// ===== RECONNECT GRACE - tự động thử lại 3 lần trước khi đá =====
const reconnectingPlayers = new Map();
const RECONNECT_GRACE_MS = 20000;
const MAX_RECONNECT_ATTEMPTS = 3;

function getReconnectKey(roomId, userId){ return `${roomId}:${userId}`; }

async function finalizeForfeitAndKick(roomId, userId, username){
  try{
    const game = activeGames.get(roomId);
    const {data: roomNow} = await supabase.from('rooms').select('*').eq('id', roomId).single().catch(()=>({data:null}));
    const isSoloRoomFinal = roomId.startsWith('SOLO-');
    
    if(roomNow && roomNow.status==='finished' && roomNow.winner_id===userId){
      console.log(`[RECONNECT FINAL] ${roomId} - ${userId} is WINNER while offline, NOT kicking`);
      reconnectingPlayers.delete(getReconnectKey(roomId, userId));
      io.to(roomId).emit('player-reconnected', {userId, username: username || 'Người chơi', roomId, message: `🏆 ${username||'Người chơi'} đã thắng khi đang offline!`});
      return;
    }
    if(game && game.pendingWin){
      const winners = game.pendingWin.winners || [];
      const isWinner = winners.some(w=> (w.player && w.player.user_id===userId) || w.user_id===userId);
      if(isWinner){
        console.log(`[RECONNECT FINAL] ${roomId} - ${userId} is PENDING WINNER, delaying`);
        const key = getReconnectKey(roomId, userId);
        const entry = reconnectingPlayers.get(key);
        if(entry){
          entry.attempt = Math.max(0, entry.attempt -1);
          scheduleReconnectCheck(roomId, userId, username);
          return;
        }
      }
    }
    if(!game && roomNow && roomNow.status==='finished'){
      console.log(`[RECONNECT FINAL] ${roomId} - Game finished, cleaning`);
      reconnectingPlayers.delete(getReconnectKey(roomId, userId));
      await supabase.from('room_players').delete().eq('room_id', roomId).eq('user_id', userId);
      io.to(roomId).emit('player-left', {userId, username: username || 'Người chơi', roomId, wasPlaying: true, forfeited: 0, reason:'reconnect_failed_finished'});
      const {data: remainingPlayers} = await supabase.from('room_players').select('*').eq('room_id', roomId);
      io.to(roomId).emit('players-update', remainingPlayers||[]);
      return;
    }

    if(isSoloRoomFinal){
      console.log(`[RECONNECT FINAL SOLO] ${roomId} - SOLO timeout, NOT forfeiting`);
      reconnectingPlayers.delete(getReconnectKey(roomId, userId));
      if(game && game.isPausedForReconnect){
        io.to(roomId).emit('game-paused-reconnect', {
          roomId, userId, username: username || 'Người chơi', isSolo: true,
          reason: 'solo_timeout_no_forfeit',
          message: `⏸️ Solo vẫn tạm dừng, quay lại bất cứ lúc nào, không mất tiền.`
        });
        return;
      }
      await supabase.from('room_players').delete().eq('room_id', roomId).eq('user_id', userId).catch(()=>{});
      io.to(roomId).emit('player-reconnect-failed', {userId, username: username || 'Người chơi', roomId, attempts: MAX_RECONNECT_ATTEMPTS, isSolo: true});
      return;
    }

    const betAmount = game ? game.roomData?.bet_amount : (roomNow ? roomNow.bet_amount : null);
    console.log(`[RECONNECT FINAL] ${roomId} - ${userId} failed ${MAX_RECONNECT_ATTEMPTS} attempts, final forfeit`);
    reconnectingPlayers.delete(getReconnectKey(roomId, userId));

    if(game && betAmount){
      if(!game.forfeitedPlayers) game.forfeitedPlayers = [];
      if(!game.forfeitedAmount) game.forfeitedAmount = 0;
      const already = game.forfeitedPlayers.some(p=>p.user_id===userId);
      if(!already){
        try{
          const prof = await getProfileById(userId);
          if(prof){
            const playerInGame = game.originalPlayers ? game.originalPlayers.find(pl=>pl.user_id===userId) : null;
            const isDemo = playerInGame ? playerInGame.is_demo : false;
            if(isDemo){
              await supabase.from('profiles').update({demo_balance: Math.max(0,(prof.demo_balance||0)-betAmount), total_wagered: (prof.total_wagered||0)+betAmount}).eq('id', userId);
            } else {
              if((prof.balance||0) >= betAmount){
                await supabase.from('profiles').update({balance: prof.balance - betAmount, total_wagered: (prof.total_wagered||0)+betAmount}).eq('id', userId);
              }
            }
            await supabase.from('transactions').insert([{user_id: userId, type:'forfeit', amount: -betAmount, room_id: roomId, description: `Mất kết nối quá ${MAX_RECONNECT_ATTEMPTS} lần - mất cược`}]);
            game.forfeitedPlayers.push({user_id: userId, username, bet: betAmount, is_demo: isDemo});
            game.forfeitedAmount += betAmount;
            io.to(roomId).emit('player-forfeited', {userId, username: username || 'Người chơi', forfeitedAmount: betAmount, totalForfeited: game.forfeitedAmount, isDemo: isDemo, reason:'reconnect_failed'});
          }
        }catch(e){ console.log('final forfeit error', e.message); }
      }
    }

    await supabase.from('room_players').delete().eq('room_id', roomId).eq('user_id', userId);
    io.to(roomId).emit('player-left', {userId, username: username || 'Người chơi', roomId, wasPlaying: !!(game && game.roomData && (game.roomData.status==='playing'||game.roomData.status==='counting')), forfeited: betAmount||0, reason:'reconnect_failed'});
    const {data: remainingPlayers} = await supabase.from('room_players').select('*').eq('room_id', roomId);
    io.to(roomId).emit('players-update', remainingPlayers||[]);

    if(game){
      try{
        game.players = remainingPlayers ? [...remainingPlayers] : [];
        if(game.clientAcks && game.clientAcks.has(userId)) game.clientAcks.delete(userId);
        const stillReal = remainingPlayers ? remainingPlayers.filter(p=>!p.is_bot).length : 0;
        if(stillReal===0){
          game.expectedAcks = 0;
          if(game.clientAcks) game.clientAcks.clear();
          game.waitingForAcks = false;
          io.to(roomId).emit('sync-complete', {roomId, reason:'no_real_players', got:0, expected:0});
          io.to(roomId).emit('sync-waiting', {roomId, got:0, expected:0, need:0});
        } else {
          game.expectedAcks = Math.max(1, stillReal);
          io.to(roomId).emit('sync-waiting', {roomId, drawIndex: game.currentDrawIndex, got: game.clientAcks?game.clientAcks.size:0, expected: game.expectedAcks, need: Math.max(0, game.expectedAcks - (game.clientAcks?game.clientAcks.size:0))});
          if(game.waitingForAcks && game.clientAcks && game.clientAcks.size >= game.expectedAcks){
            io.to(roomId).emit('sync-complete', {roomId, got: game.clientAcks.size, expected: game.expectedAcks, reason:'player_left_enough'});
          }
        }
        if(!remainingPlayers || remainingPlayers.length===0){
          await supabase.from('rooms').delete().eq('id', roomId);
          activeGames.delete(roomId);
        }
      }catch(e){ console.log('final kick sync error', e.message); }
    } else {
      if(!remainingPlayers || remainingPlayers.length===0){
        await supabase.from('rooms').delete().eq('id', roomId);
        activeGames.delete(roomId);
      }
    }

    io.to(roomId).emit('player-reconnect-failed', {userId, username: username || 'Người chơi', roomId, attempts: MAX_RECONNECT_ATTEMPTS, message: `${username||'Người chơi'} mất kết nối quá ${MAX_RECONNECT_ATTEMPTS} lần, đã rời phòng và mất cược.`});
    io.to(roomId).emit('toast', {message: `💔 ${username||'Người chơi'} mất kết nối ${MAX_RECONNECT_ATTEMPTS} lần, đã bị loại khỏi phòng!`, type:'error'});
  }catch(e){ console.log('finalizeForfeitAndKick error', e.message); }
}

function scheduleReconnectCheck(roomId, userId, username){
  const key = getReconnectKey(roomId, userId);
  const entry = reconnectingPlayers.get(key);
  if(!entry) return;
  if(entry.timer) clearTimeout(entry.timer);
  if(entry.attempt >= MAX_RECONNECT_ATTEMPTS){
    finalizeForfeitAndKick(roomId, userId, username);
    return;
  }
  entry.timer = setTimeout(async ()=>{
    const still = reconnectingPlayers.get(key);
    if(!still) return;
    console.log(`[RECONNECT] ${roomId} - ${userId} attempt ${still.attempt}/${MAX_RECONNECT_ATTEMPTS} timed out`);
    still.attempt += 1;
    if(still.attempt > MAX_RECONNECT_ATTEMPTS){
      finalizeForfeitAndKick(roomId, userId, username);
    } else {
      io.to(roomId).emit('player-reconnecting', {
        userId,
        username: username || still.username || 'Người chơi',
        roomId,
        attempt: still.attempt,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        message: `📡 ${username||'Người chơi'} mất kết nối, đang thử lại ${still.attempt}/${MAX_RECONNECT_ATTEMPTS}...`
      });
      io.to(roomId).emit('toast', {message: `📡 ${username||'Người chơi'} mất kết nối, thử lại ${still.attempt}/${MAX_RECONNECT_ATTEMPTS} (${RECONNECT_GRACE_MS/1000}s)...`, type:'warning'});
      scheduleReconnectCheck(roomId, userId, username);
    }
  }, RECONNECT_GRACE_MS);
}


io.on('connection', (socket)=>{
  console.log('socket connected', socket.id);

  socket.on('join-room', async ({roomId, userId, password, ticket, ticketColor, isDemo})=>{
    const {data: room} = await supabase.from('rooms').select('*').eq('id',roomId).single();
    if(!room) return socket.emit('error','Phòng không tồn tại');

    const reconnectKey = getReconnectKey(roomId, userId);
    const isReconnecting = reconnectingPlayers.has(reconnectKey);
    let isRejoinAfterDisconnect = false;
    if(isReconnecting){
      console.log(`[RECONNECT] ${roomId} - ${userId} is reconnecting, allowing join during playing`);
      const recEntry = reconnectingPlayers.get(reconnectKey);
      if(recEntry && recEntry.timer) clearTimeout(recEntry.timer);
      reconnectingPlayers.delete(reconnectKey);
      isRejoinAfterDisconnect = true;
    } else {
      const existingGame = activeGames.get(roomId);
      if(room.status === 'playing' || room.status === 'counting' || (existingGame && existingGame.isDrawing)){
        const {data: alreadyInRoom} = await supabase.from('room_players').select('id').eq('room_id', roomId).eq('user_id', userId).maybeSingle();
        if(!alreadyInRoom){
          console.log(`[JOIN BLOCKED] ${roomId} - Room is playing/counting, blocking join for ${userId}`);
          return socket.emit('join-blocked-playing', {roomId, message: 'Phòng đang quay số, vui lòng chờ ván sau!'});
        }
        isRejoinAfterDisconnect = true;
      }
    }
    if(room.password && room.password!==password) return socket.emit('error','Sai mật khẩu phòng');
    socket.join(roomId);
    socket.data.userId = userId;
    socket.data.roomId = roomId;
    const {data: existList} = await supabase.from('room_players').select('*').eq('room_id',roomId).eq('user_id',userId);
    // Kiểm tra giới hạn phòng - đã tăng từ 5 lên 10
    const {data: allPlayersCheck} = await supabase.from('room_players').select('id').eq('room_id',roomId);
    const maxPlayersAllowed = Math.max(room.max_players || 5, 10); // ép 10
    if((!existList || existList.length===0) && allPlayersCheck && allPlayersCheck.length >= maxPlayersAllowed){
      return socket.emit('error','Phòng đã đầy ('+maxPlayersAllowed+' người)! Vui lòng chọn phòng khác.');
    }
    if(!existList || existList.length===0){
      const finalTicket = ticket || generateLotoTicket();
      const username = await getUsernameById(userId);
      const color = ticketColor || '#'+Math.floor(Math.random()*16777215).toString(16);
      const is_demo = !!isDemo;
      await supabase.from('room_players').insert({room_id:roomId, user_id:userId, username: username, ticket: finalTicket, ticket_color: color, is_bot:false, is_demo});
    } else if(existList.length>1){
      for(let i=1;i<existList.length;i++){
        await supabase.from('room_players').delete().eq('id', existList[i].id);
      }
    }
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
    // Cache host
    if(room.host_id){
      roomHosts.set(roomId, room.host_id);
    } else if(!roomHosts.has(roomId) && players && players.length>0){
      // First player becomes host if no host
      const firstReal = players.find(p=>!p.is_bot);
      if(firstReal){
        roomHosts.set(roomId, firstReal.user_id);
        try{ await supabase.from('rooms').update({host_id: firstReal.user_id}).eq('id', roomId); }catch(e){}
      }
    }
    // Add ready info to players
    const readyMapForJoin = roomReadyStates.get(roomId);
    const playersWithReady = (players||[]).map(p=>{
      const isReady = readyMapForJoin ? !!readyMapForJoin.get(p.user_id) : false;
      return {...p, isReady};
    });
    io.to(roomId).emit('players-update', playersWithReady);

    if(isRejoinAfterDisconnect){
      try{
        const game = activeGames.get(roomId);
        const {data: allPlayersNow} = await supabase.from('room_players').select('*').eq('room_id', roomId);
        if(game){
          game.players = allPlayersNow ? [...allPlayersNow] : [];
          const realNow = allPlayersNow ? allPlayersNow.filter(p=>!p.is_bot).length : 1;
          const restoredExpected = Math.max(1, realNow);
          console.log(`[RECONNECT SUCCESS] ${roomId} - ${userId} reconnected, expectedAcks ${game.expectedAcks} -> ${restoredExpected}`);
          game.expectedAcks = restoredExpected;
          if(game._originalExpectedAcks) delete game._originalExpectedAcks;
          const reconUsername = await getUsernameById(userId) || 'Người chơi';
          io.to(roomId).emit('player-reconnected', {userId, username: reconUsername, roomId, message: `✅ ${reconUsername} đã kết nối lại!`});
          io.to(roomId).emit('toast', {message: `✅ ${reconUsername} đã kết nối lại!`, type:'success'});
          io.to(roomId).emit('sync-waiting', {roomId, drawIndex: game.currentDrawIndex, got: game.clientAcks?game.clientAcks.size:0, expected: game.expectedAcks, need: Math.max(0, game.expectedAcks - (game.clientAcks?game.clientAcks.size:0))});
          
          if(game.isPausedForReconnect){
            console.log(`[RECONNECT RESUME SOLO] ${roomId} - Resuming paused solo game for ${userId}`);
            game.isPausedForReconnect = false;
            game.waitingForReconnect = false;
            if(game.resumeDraw){
              game.timeout = setTimeout(()=>{ try{ game.resumeDraw(); }catch(e){ console.log('resume draw error', e.message); } }, 1500);
              io.to(roomId).emit('game-resumed-reconnect', {roomId, userId, username: reconUsername, message: `▶️ Game tiếp tục sau khi ${reconUsername} kết nối lại!`});
              io.to(roomId).emit('toast', {message: `▶️ Solo tiếp tục quay!`, type:'success'});
            }
          }
          
          if(game.drawn && game.drawn.length>0){
            const currentRoomAudioMode = game.audioMode || roomAudioModes.get(roomId) || "MUSIC";
            socket.emit('reconnect-sync', {
              roomId,
              drawn: [...game.drawn],
              currentNumber: game.drawn[game.drawn.length-1],
              drawIndex: game.currentDrawIndex,
              totalDrawn: game.drawn.length,
              expected: game.expectedAcks,
              isReconnect: true,
              message: `📥 Đã bỏ lỡ ${game.drawn.length} số trong lúc mất kết nối, đang đồng bộ...`
            });
            socket.emit('number-drawn', {number: game.drawn[game.drawn.length-1], drawn: [...game.drawn], audioVariant: getAudioVariantForNumber(game.drawn[game.drawn.length-1], game.currentDrawIndex, roomId), drawIndex: game.currentDrawIndex, roomId, audioMode: currentRoomAudioMode, isReconnectSync: true});
            
            if(game.pendingWin){
              const pw = game.pendingWin;
              const winners = pw.winners || [];
              const isWinnerSelf = winners.some(w=>w.player && w.player.user_id===userId);
              socket.emit('win-pending', {
                roomId,
                winningNumber: pw.winningNumber,
                winners: winners.map(w=>({user_id:w.player.user_id, username:w.player.username})),
                drawIndex: pw.drawIndex,
                isReconnect: true,
                isWinnerSelf,
                message: isWinnerSelf ? `🎉 Bạn đã thắng với số ${pw.winningNumber} trong lúc mất kết nối!` : `Có người thắng với số ${pw.winningNumber} trong lúc bạn offline...`
              });
            }

            try{
              const {data: roomNow} = await supabase.from('rooms').select('*').eq('id', roomId).single();
              if(roomNow && roomNow.status==='finished' && roomNow.winner_id){
                const winnerId = roomNow.winner_id;
                if(winnerId===userId){
                  socket.emit('game-won-offline', {
                    roomId,
                    winnerId,
                    isSelfWinner: true,
                    winningNumber: game.drawn[game.drawn.length-1],
                    drawn: [...game.drawn],
                    message: `🏆 Bạn đã thắng trong lúc mất kết nối! Tiền thưởng đã cộng.`,
                    reason: 'won_while_offline'
                  });
                } else {
                  socket.emit('game-ended-offline', {
                    roomId,
                    winnerId,
                    isSelfWinner: false,
                    message: `Trò chơi đã kết thúc trong lúc bạn offline.`,
                    reason: 'finished_while_offline'
                  });
                }
              }
            }catch(e){ console.log('check finished while offline error', e.message); }
          }
        } else {
          const {data: roomNow} = await supabase.from('rooms').select('*').eq('id', roomId).single();
          if(roomNow && roomNow.current_numbers && roomNow.current_numbers.length>0){
            socket.emit('reconnect-sync', {
              roomId,
              drawn: [...roomNow.current_numbers],
              currentNumber: roomNow.current_numbers[roomNow.current_numbers.length-1],
              totalDrawn: roomNow.current_numbers.length,
              isReconnect: true,
              fromDB: true
            });
          }
          const reconUsername = await getUsernameById(userId) || 'Người chơi';
          io.to(roomId).emit('player-reconnected', {userId, username: reconUsername, roomId});
        }
      }catch(e){ console.log('reconnect restore error', e.message); }
    }

    // Emit room-info with hostId and status
    const hostIdToSend = room.host_id || roomHosts.get(roomId) || null;
    io.to(roomId).emit('room-info', {...room, hostId: hostIdToSend, host_id: hostIdToSend, status: room.status || 'waiting', isPlaying: room.status==='playing'});
    const currentAudioMode = roomAudioModes.get(roomId) || room.audio_mode || "MUSIC";
    io.to(roomId).emit('room-audio-mode', {roomId, mode: currentAudioMode});
    socket.emit('room-audio-mode', {roomId, mode: currentAudioMode});
    const joinedPlayer = players.find(p=>p.user_id===userId);
    const joinedUsername = joinedPlayer ? (joinedPlayer.username || await getUsernameById(userId) || 'Người chơi') : (await getUsernameById(userId) || 'Người chơi');
    io.to(roomId).emit('player-joined', {userId, username: joinedUsername, roomId});

    // ===== FIX: Cập nhật số lượng máy khi có người vào giữa trận =====
    try{
      const game = activeGames.get(roomId);
      if(game){
        // Nếu phòng đang chơi, thêm người chơi vào game và cập nhật expectedAcks
        const realPlayersNow = players.filter(p=>!p.is_bot);
        const oldExpected = game.expectedAcks;
        const newExpected = Math.max(1, realPlayersNow.length);
        
        // Kiểm tra xem player đã có trong game chưa
        const alreadyInGame = game.players.some(p=>p.user_id===userId && !p.is_bot);
        if(!alreadyInGame){
          // Thêm player mới vào danh sách game
          const newPlayerData = players.find(p=>p.user_id===userId);
          if(newPlayerData){
            game.players.push(newPlayerData);
            game.originalPlayers.push(newPlayerData);
          }
        }
        
        if(newExpected !== oldExpected){
          console.log(`[PLAYER JOINED MID-GAME] ${roomId} - Player ${joinedUsername} (${userId}) joined during game. expectedAcks ${oldExpected} -> ${newExpected} (total real players: ${realPlayersNow.length})`);
          game.expectedAcks = newExpected;
          
          // Gửi thông tin cập nhật cho tất cả clients
          io.to(roomId).emit('sync-player-count-updated', {
            roomId,
            oldExpected,
            newExpected,
            totalPlayers: realPlayersNow.length,
            joinedUserId: userId,
            joinedUsername,
            message: `Có người mới vào phòng, giờ cần chờ ${newExpected} máy`
          });
          
          // Nếu đang chờ ack, kiểm tra lại xem đã đủ chưa với số mới
          if(game.waitingForAcks){
            console.log(`[SYNC] ${roomId} - After join, waiting ${game.clientAcks.size}/${game.expectedAcks} acks`);
          }
        }
        
        // Gửi trạng thái game hiện tại cho người mới vào
        if(game.drawn && game.drawn.length > 0){
          socket.emit('game-state-sync', {
            roomId,
            drawn: [...game.drawn],
            currentDrawIndex: game.currentDrawIndex,
            expectedAcks: game.expectedAcks,
            totalPlayers: realPlayersNow.length,
            isPlaying: game.isDrawing,
            waitingForAcks: game.waitingForAcks,
            gotAcks: game.clientAcks.size
          });
          console.log(`[MID-GAME JOIN] ${roomId} - Sent game state to new player ${joinedUsername}: ${game.drawn.length} numbers drawn, waiting ${game.clientAcks.size}/${game.expectedAcks}`);
        }
      }
    }catch(e){
      console.log('mid-game join sync error', e.message);
    }
  });

  socket.on('create-solo', async ({userId, botCount, betAmount, ticket, ticketColor, isDemo})=>{
    const roomId = 'SOLO-'+nanoid(6).toUpperCase();
    const fee = Math.max(5, 20 - (botCount-1)*2);
    await supabase.from('rooms').insert({id:roomId, host_id:userId, bet_amount:betAmount, max_players:botCount+1, fee_percent:fee, status:'waiting', name:`Solo ${botCount} bot`});
    const username = await getUsernameById(userId);
    const color = ticketColor || '#00d2ff';
    const is_demo = !!isDemo;
    await supabase.from('room_players').insert({room_id:roomId, user_id:userId, username: username, ticket: ticket || generateLotoTicket(), ticket_color: color, is_bot:false, is_demo});
    const botColors = ['#ff6b35','#9c27b0','#00bcd4','#e91e63','#4caf50','#ff9800'];
    for(let i=0;i<botCount;i++){
      await supabase.from('room_players').insert({room_id:roomId, is_bot:true, bot_name:`Bot ${i+1}`, ticket: generateLotoTicket(), ticket_color: botColors[i % botColors.length], is_demo:false});
    }
    socket.join(roomId);
    socket.data.userId = userId;
    socket.data.roomId = roomId;
    socket.emit('solo-created', {roomId, fee});
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
    io.to(roomId).emit('players-update', players);
    const {data: room} = await supabase.from('rooms').select('*').eq('id',roomId).single();
    io.to(roomId).emit('room-info', room);
    const currentAudioMode = roomAudioModes.get(roomId) || room.audio_mode || "MUSIC";
    io.to(roomId).emit('room-audio-mode', {roomId, mode: currentAudioMode});
    socket.emit('room-audio-mode', {roomId, mode: currentAudioMode});
    const joinedPlayer = players.find(p=>p.user_id===userId);
    const joinedUsername = joinedPlayer ? (joinedPlayer.username || await getUsernameById(userId) || 'Người chơi') : (await getUsernameById(userId) || 'Người chơi');
    io.to(roomId).emit('player-joined', {userId, username: joinedUsername, roomId});
  });

    socket.on('start-game', async ({roomId, userId})=>{
    if(activeGames.has(roomId)) return;

    // === NEW: CHECK HOST + READY ===
    try{
      const {data: roomCheck} = await supabase.from('rooms').select('*').eq('id', roomId).single();
      const hostId = roomCheck ? roomCheck.host_id : roomHosts.get(roomId);
      // Chỉ chủ phòng mới được bắt đầu
      if(hostId && userId && hostId !== userId){
        console.log(`[BLOCKED] ${roomId} start blocked - ${userId} not host (${hostId})`);
        io.to(roomId).emit('toast', {message: '🚫 Chỉ chủ phòng mới được bắt đầu!', type:'warning'});
        return socket.emit('error', 'Chỉ chủ phòng mới được bắt đầu');
      }

      const {data: playersCheck, error: playersCheckErr} = await supabase.from('room_players').select('*').eq('room_id', roomId);
      if(playersCheckErr) console.log('[START-GAME] fetch players error', playersCheckErr.message);
      const realPlayersCheck = (playersCheck||[]).filter(p=>!p.is_bot);
      const isSoloRoomCheck = roomId && roomId.startsWith('SOLO-');
      // Chỉ check 2 người cho phòng riêng, solo thì bỏ qua
      if(!isSoloRoomCheck && realPlayersCheck.length < 2){
        console.log(`[BLOCKED] ${roomId} start blocked - only ${realPlayersCheck.length} real player(s), need 2`);
        io.to(roomId).emit('toast', {
          message: `⚠️ Phòng riêng cần ít nhất 2 người mới được bắt đầu! Hiện có ${realPlayersCheck.length}/2 người. Hãy chia sẻ ID phòng để mời thêm bạn!`,
          type: 'warning'
        });
        io.to(roomId).emit('game-error', {
          code: 'NEED_2_PLAYERS',
          message: 'Phòng riêng cần ít nhất 2 người',
          current: realPlayersCheck.length,
          required: 2
        });
        await supabase.from('rooms').update({status:'waiting'}).eq('id', roomId);
        return;
      }


      // Kiểm tra tất cả non-host đã sẵn sàng chưa
      if(!isSoloRoomCheck){
        const readyMap = roomReadyStates.get(roomId);
        const nonHost = realPlayersCheck.filter(p=>p.user_id !== hostId);
        if(nonHost.length>0){
          const notReady = nonHost.filter(p=>{
            const isReady = readyMap ? readyMap.get(p.user_id) : false;
            return !isReady;
          });
          if(notReady.length>0){
            console.log(`[BLOCKED] ${roomId} start blocked - ${notReady.length} players not ready`);
            io.to(roomId).emit('start-blocked-not-ready', {ready: nonHost.length - notReady.length, total: nonHost.length});
            io.to(roomId).emit('toast', {message: `⚠️ Chờ ${notReady.length} người chưa sẵn sàng! (${nonHost.length - notReady.length}/${nonHost.length})`, type:'warning'});
            return;
          }
        }
      }
    }catch(e){
      console.log('[START-GAME] check host/ready error', e.message);
    }

    await supabase.from('rooms').update({status:'counting'}).eq('id',roomId);
    io.to(roomId).emit('countdown-start');
    setTimeout(async ()=>{
      // Check lại lần 2 ngay trước khi bắt đầu quay (tránh race khi có người out trong lúc đếm ngược)
      try{
        const {data: playersRecheck} = await supabase.from('room_players').select('*').eq('id', roomId).limit(1);
      }catch(e){}
      try{
        const {data: playersRecheck2} = await supabase.from('room_players').select('*').eq('room_id', roomId);
        const realRecheck = (playersRecheck2||[]).filter(p=>!p.is_bot);
        const isSoloRecheck = roomId && roomId.startsWith('SOLO-');
        if(!isSoloRecheck && realRecheck.length < 2){
          console.log(`[BLOCKED-COUNTDOWN] ${roomId} - not enough players after countdown (${realRecheck.length}/2)`);
          io.to(roomId).emit('toast', {message:'❌ Phòng riêng cần ít nhất 2 người, đã hủy bắt đầu! Mời thêm bạn vào.', type:'error'});
          await supabase.from('rooms').update({status:'waiting'}).eq('id', roomId);
          io.to(roomId).emit('game-cancelled', {reason:'not_enough_players', current: realRecheck.length});
          return;
        }
      }catch(e){ console.log('recheck error', e.message); }

      await supabase.from('rooms').update({status:'playing', current_numbers:[]}).eq('id',roomId);
      const allNumbers = Array.from({length:90},(_,i)=>i+1).sort(()=>Math.random()-0.5);
      const drawn = [];
      const drawnSet = new Set();
      const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
      const {data: roomData} = await supabase.from('rooms').select('*').eq('id',roomId).single();
      // FIX SYNC DYNAMIC: chờ đủ TẤT CẢ máy trong phòng (động: 2 máy=>2, 3 máy=>3, 4 máy=>4...)
      const realPlayers = players.filter(p=>!p.is_bot);
      const gameState = {
        drawn,
        drawnSet,
        players,
        originalPlayers: [...players],
        roomData,
        allNumbers,
        currentIdx: 0,
        forfeitedPlayers:[],
        forfeitedAmount:0,
        clientAcks: new Set(),
        expectedAcks: Math.max(1, realPlayers.length),
        currentDrawIndex: -1,
        lastDrawTime: null,
        isDrawing: true,
        waitingForAcks: false,
        timeout: null,
        interval: null,
        syncCheckInterval: null,
        isPausedForReconnect: false,
        waitingForReconnect: false,
        audioSyncEnabled: true
      };
      console.log(`[GAME START] ${roomId} - ${realPlayers.length} players, expectedAcks=${gameState.expectedAcks}, audioSyncEnabled=true`);
      activeGames.set(roomId, gameState);

      const drawNextWithSync = async ()=>{
        const game = activeGames.get(roomId);
        if(!game || !game.isDrawing) return;
        if(game.currentIdx >= 90){
          activeGames.delete(roomId);
          io.to(roomId).emit('game-ended', {reason:'no numbers left'});
          return;
        }
        const num = game.allNumbers[game.currentIdx];
        const audioVariant = getAudioVariantForNumber(num, game.currentIdx, roomId);
        game.drawn.push(num);
        game.drawnSet.add(num);
        game.currentIdx++;
        // Reset ack cho số mới, lưu index hiện tại - QUAN TRỌNG: chờ đủ TẤT CẢ máy trong phòng
        game.clientAcks.clear();
        game.currentDrawIndex = game.drawn.length - 1;
        game.lastDrawTime = Date.now();
        game.waitingForAcks = true;
        // Cập nhật expectedAcks động theo số người chơi thực tế CÒN LẠI trong phòng
        // Phòng có 2 máy thì chờ 2, 3 máy thì chờ 3, 4 máy thì chờ 4...
        try{
          const activeRealPlayers = game.players ? game.players.filter(p=>!p.is_bot).length : game.expectedAcks;
          // Trừ đi những người đã forfeited (đã rời)
          const forfeitedCount = game.forfeitedPlayers ? game.forfeitedPlayers.length : 0;
          const stillActive = Math.max(1, activeRealPlayers - 0); // giữ nguyên active, forfeited đã được xử lý ở player-left
          if(stillActive > 0) {
            if(stillActive !== game.expectedAcks){
              console.log(`[SYNC RESET] ${roomId} new draw #${game.currentDrawIndex} (num ${num}) - expectedAcks ${game.expectedAcks} -> ${stillActive} (active players)`);
            }
            game.expectedAcks = Math.max(1, stillActive);
          }
          console.log(`[DRAW] ${roomId} - Draw #${game.currentDrawIndex}: number ${num}, waiting for ${game.expectedAcks} players to finish audio`);
          // Thông báo cho clients biết đang chờ bao nhiêu máy
          io.to(roomId).emit('draw-started', {
            roomId,
            drawIndex: game.currentDrawIndex,
            number: num,
            expected: game.expectedAcks,
            drawn: [...game.drawn]
          });
        }catch(e){}

        await supabase.from('rooms').update({current_numbers: game.drawn}).eq('id',roomId);
        // Gửi full drawn để frontend đồng bộ ngay, không chờ audio
                const currentRoomAudioMode = game.audioMode || roomAudioModes.get(roomId) || "MUSIC";
        io.to(roomId).emit('number-drawn', {number:num, drawn: [...game.drawn], audioVariant, drawIndex: game.drawn.length-1, roomId, audioMode: currentRoomAudioMode});

        // ==== LOGIC WIN MỚI: SOLO HÒA NẾU CẢ NGƯỜI + BOT CÙNG WIN ====
        let winnersFound = [];
        let botWinners = [];
        for(const p of game.players){
          const winInfo = getWinningRowInfo(p.ticket, game.drawnSet);
          if(!winInfo) continue;
          if(p.is_bot) botWinners.push({player: p, winInfo});
          else winnersFound.push({player: p, winInfo});
        }
        const isSoloRoom = roomId && roomId.startsWith('SOLO-');

        // === TRƯỜNG HỢP HÒA: SOLO mà cả người thật + bot cùng trúng 1 số ===
        if(isSoloRoom && winnersFound.length>0 && botWinners.length>0){
          console.log(`[DRAW - SOLO TIE] ${roomId} - Both real and bot win with number ${num}: real=${winnersFound.map(w=>w.player.user_id).join(',')} bot=${botWinners.map(w=>w.player.username).join(',')}`);
          game.isDrawing = false;
          game.pendingWin = null;
          game.waitingForAcks = true;

          io.to(roomId).emit('win-pending', {
            roomId,
            winningNumber: num,
            isDraw: true,
            winners: winnersFound.map(w=>({user_id:w.player.user_id, username:w.player.username})),
            botWinners: botWinners.map(w=>({username:w.player.username})),
            drawIndex: game.drawn.length - 1,
            message: `Hòa! Bạn và bot cùng thắng với số ${num}, đang chờ hoàn tất...`
          });

          let waitedForWin = 0;
          const winCheckInterval = 300;
          const maxWinWait = 15000;
          const checkWinSync = setInterval(async ()=>{
            waitedForWin += winCheckInterval;
            const got = game.clientAcks.size;
            const expected = Math.max(1, game.expectedAcks || 1);
            const allAcked = got >= expected;
            const timedOut = waitedForWin >= maxWinWait;
            if(allAcked || timedOut){
              clearInterval(checkWinSync);
              if(game.timeout) clearTimeout(game.timeout);
              const bet = roomData.bet_amount;
              // Hòa: hoàn tiền cho người thật (không thu phí, không thắng thua)
              console.log(`[DRAW REFUND] ${roomId} - Refunding ${bet} to ${winnersFound.length} real players`);
              for(const {player: p} of winnersFound){
                // Không trừ không cộng, chỉ ghi log transaction hòa
                const prof = await getProfileById(p.user_id);
                if(prof){
                  await supabase.from('transactions').insert([{user_id: p.user_id, type:'draw_refund', amount: 0, room_id: roomId, description: `Hòa với bot số ${num} - hoàn cược ${bet}`}]);
                }
              }
              await supabase.from('rooms').update({status:'finished', winner_id: null}).eq('id',roomId);
              activeGames.delete(roomId);
              roomReadyStates.delete(roomId);
              io.to(roomId).emit('game-draw', {
                number: num,
                drawn: [...game.drawn],
                winners: winnersFound.map(w=>w.player),
                botWinners: botWinners.map(w=>w.player),
                reason: 'draw_both_win',
                message: `Hòa! Bạn và bot cùng thắng với số ${num}`,
                betRefunded: bet,
                isDraw: true
              });
              io.to(roomId).emit('game-finished-can-restart', {
                roomId,
                canRestart: true,
                isDraw: true,
                message: `Hòa! Cùng thắng số ${num} - tiền cược được hoàn lại`
              });
              io.to(roomId).emit('room-status', {status:'waiting'});
            }
          }, winCheckInterval);
          return;
        }

        // Nếu không hòa, tiếp tục logic cũ nhưng đã tính đủ botWinners
        // (winnersFound và botWinners đã được tính ở trên)


        // Nếu có người thắng (thật)
        if(winnersFound.length>0){
          // CÓ NGƯỜI THẮNG - CHIA ĐỀU POT
          console.log(`[WIN DETECTED - MULTI] ${roomId} - ${winnersFound.length} winners with number ${num}: ${winnersFound.map(w=>w.player.user_id).join(', ')}`);
          game.isDrawing = false;
          game.pendingWin = {
            winners: winnersFound,
            winningNumber: num,
            drawn: [...game.drawn],
            roomData,
            drawIndex: game.drawn.length - 1
          };
          game.waitingForAcks = true;
          
          io.to(roomId).emit('win-pending', {
            roomId,
            winningNumber: num,
            winnerId: winnersFound[0].player.user_id,
            winners: winnersFound.map(w=>({user_id:w.player.user_id, username:w.player.username})),
            drawIndex: game.drawn.length - 1,
            message: winnersFound.length>1 ? `Có ${winnersFound.length} người cùng thắng với số ${num}, chờ tất cả máy quay xong...` : `Có người thắng với số ${num}, chờ tất cả máy quay xong...`
          });

          let waitedForWin = 0;
          const winCheckInterval = 300;
          const maxWinWait = 15000;
          
          const checkWinSync = setInterval(async ()=>{
            waitedForWin += winCheckInterval;
            const got = game.clientAcks.size;
            const expected = Math.max(1, game.expectedAcks || 1);
            const allAcked = got >= expected;
            const timedOut = waitedForWin >= maxWinWait;

            if(waitedForWin % 1500 < winCheckInterval){
              console.log(`[WIN SYNC WAIT] ${roomId} - Winning number ${num} - Got ${got}/${expected} acks, waited ${waitedForWin}ms`);
              io.to(roomId).emit('sync-waiting', {
                roomId,
                drawIndex: game.currentDrawIndex,
                number: num,
                got,
                expected,
                waited: waitedForWin,
                need: expected - got,
                isWinningNumber: true,
                message: `Số thắng ${num} - đang chờ ${expected - got} máy quay xong`
              });
            }

            if(allAcked || timedOut){
              clearInterval(checkWinSync);
              if(timedOut){
                console.log(`[WIN SYNC TIMEOUT] ${roomId} - Only ${got}/${expected} acks for winning number ${num} after ${waitedForWin}ms, forcing game-won`);
              } else {
                console.log(`[WIN SYNC OK] ${roomId} - All ${got}/${expected} clients finished winning number ${num}, now emitting game-won`);
              }

              if(game.timeout) clearTimeout(game.timeout);
              
              const bet = roomData.bet_amount;
              const feePercent = roomData.fee_percent;
              const originalCount = game.originalPlayers ? game.originalPlayers.length : game.players.filter(pl=>!pl.is_bot).length;
              const forfeitedCount = game.forfeitedPlayers ? game.forfeitedPlayers.length : 0;
              const totalPlayersForPot = Math.max(game.players.filter(pl=>!pl.is_bot).length + forfeitedCount, originalCount);
              const totalPot = totalPlayersForPot * bet;
              const fee = Math.floor(totalPot * feePercent / 100);
              const netPot = totalPot - fee;
              // CHIA ĐỀU
              const share = Math.floor(netPot / winnersFound.length);
              let remainder = netPot - share * winnersFound.length;

              console.log(`[POT SPLIT] ${roomId} - totalPot=${totalPot} fee=${fee} net=${netPot} winners=${winnersFound.length} share=${share} remainder=${remainder}`);

              // Trừ tiền những người thua (không phải winner)
              for(const pl of game.players){
                if(pl.is_bot) continue;
                if(winnersFound.some(w=>w.player.id===pl.id || w.player.user_id===pl.user_id)) continue;
                const alreadyForfeited = game.forfeitedPlayers && game.forfeitedPlayers.some(fp => fp.user_id === pl.user_id);
                if(alreadyForfeited) continue;
                const prof = await getProfileById(pl.user_id);
                if(!prof) continue;
                const isDemoPlayer = pl.is_demo;
                if(isDemoPlayer){
                  const newDemo = Math.max(0, (prof.demo_balance || 0) - bet);
                  await supabase.from('profiles').update({
                    demo_balance: newDemo,
                    total_wagered: (prof.total_wagered || 0) + bet
                  }).eq('id', pl.user_id);
                  await supabase.from('transactions').insert([{user_id: pl.user_id, type:'lose_demo', amount: -bet, room_id:roomId, description: `Thua ${bet} demo - chia pot cho ${winnersFound.length} người thắng`}]);
                } else {
                  const newBal = (prof.balance || 0) - bet;
                  await supabase.from('profiles').update({
                    balance: newBal,
                    total_wagered: (prof.total_wagered || 0) + bet
                  }).eq('id', pl.user_id);
                  await supabase.from('transactions').insert([{user_id: pl.user_id, type:'lose', amount: -bet, room_id:roomId, description: `Thua ${bet} - chia pot cho ${winnersFound.length} người thắng`}]);
                }
              }

              // Cộng tiền cho từng người thắng (chia đều)
              for(let i=0;i<winnersFound.length;i++){
                const {player: p} = winnersFound[i];
                const amount = share + (i===0 ? remainder : 0);
                const winnerProf = await getProfileById(p.user_id);
                if(winnerProf){
                  const isDemoWinner = p.is_demo;
                  if(isDemoWinner){
                    const newDemo = (winnerProf.demo_balance || 0) + amount;
                    await supabase.from('profiles').update({
                      demo_balance: newDemo,
                      total_wagered: (winnerProf.total_wagered || 0) + bet
                    }).eq('id', p.user_id);
                    await supabase.from('transactions').insert([{user_id: p.user_id, type:'win_demo', amount: amount, room_id:roomId, description: `Thắng ${amount} demo - chia đều ${winnersFound.length} người cùng thắng số ${num}`}]);
                  } else {
                    await supabase.from('profiles').update({
                      balance: (winnerProf.balance || 0) + amount,
                      total_wagered: (winnerProf.total_wagered || 0) + bet
                    }).eq('id', p.user_id);
                    await supabase.from('transactions').insert([{user_id: p.user_id, type:'win', amount: amount, room_id:roomId, description: `Thắng ${amount} - chia đều ${winnersFound.length} người cùng thắng số ${num}`}]);
                  }
                }
              }

              await supabase.from('rooms').update({status:'finished', winner_id: winnersFound[0].player.user_id || null}).eq('id',roomId);
              
              activeGames.delete(roomId);
              roomReadyStates.delete(roomId);
              
              io.to(roomId).emit('game-won', {
                winners: winnersFound.map(w=>w.player),
                winner: winnersFound[0].player,
                number: num, 
                drawn: [...game.drawn], 
                winningRow: winnersFound[0].winInfo.row, 
                winningNumbers: winnersFound[0].winInfo.numbers, 
                winAmount: share, 
                share,
                fee, 
                totalPot, 
                netPot,
                reason:'bingo', 
                forfeitedAmount: game.forfeitedAmount || 0, 
                isDemoWin: winnersFound[0].player.is_demo,
                finalSpinCompleted: true,
                winnersCount: winnersFound.length
              });

              io.to(roomId).emit('game-finished-can-restart', {
                roomId,
                canRestart: true,
                message: winnersFound.length>1 ? `Có ${winnersFound.length} người cùng thắng, pot chia đều!` : 'Ván kết thúc, có thể bắt đầu lại'
              });
              io.to(roomId).emit('room-status', {status:'waiting'});
            }
          }, winCheckInterval);
          
          return;
        }

        // Nếu chỉ có bot thắng (không có người thật thắng)
        if(botWinners.length>0 && winnersFound.length===0){
          let winnerFound = botWinners[0].player;
          let winnerInfo = botWinners[0].winInfo;

          // CÓ NGƯỜI THẮNG - KHÔNG DỪNG NGAY, CHỜ TẤT CẢ MÁY QUAY XONG SỐ CUỐI
          const p = winnerFound;
          const winInfo = winnerInfo;
          console.log(`[WIN DETECTED] ${roomId} - Player ${p.user_id} wins with number ${num}, waiting for all clients to finish final spin...`);
          
          // Đánh dấu đang chờ win - dừng quay tiếp nhưng chưa xóa game
          game.isDrawing = false;
          game.pendingWin = {
            player: p,
            winInfo,
            winningNumber: num,
            drawn: [...game.drawn],
            roomData,
            drawIndex: game.drawn.length - 1
          };
          game.waitingForAcks = true;
          
          // Gửi thông báo có người thắng nhưng chưa kết thúc, yêu cầu các máy hoàn tất vòng quay
          io.to(roomId).emit('win-pending', {
            roomId,
            winningNumber: num,
            winnerId: p.user_id,
            drawIndex: game.drawn.length - 1,
            message: `Có người thắng với số ${num}, chờ tất cả máy quay xong...`
          });

          // Chờ tất cả máy báo đã quay xong số win (client-audio-done) rồi mới xử lý thắng thua
          let waitedForWin = 0;
          const winCheckInterval = 300;
          const maxWinWait = 15000; // tối đa 15s chờ tất cả máy quay xong số cuối
          
          const checkWinSync = setInterval(async ()=>{
            waitedForWin += winCheckInterval;
            const got = game.clientAcks.size;
            const expected = Math.max(1, game.expectedAcks || 1);
            const allAcked = got >= expected;
            const timedOut = waitedForWin >= maxWinWait;

            if(waitedForWin % 1500 < winCheckInterval){
              console.log(`[WIN SYNC WAIT] ${roomId} - Winning number ${num} - Got ${got}/${expected} acks, waited ${waitedForWin}ms`);
              io.to(roomId).emit('sync-waiting', {
                roomId,
                drawIndex: game.currentDrawIndex,
                number: num,
                got,
                expected,
                waited: waitedForWin,
                need: expected - got,
                isWinningNumber: true,
                message: `Số thắng ${num} - đang chờ ${expected - got} máy quay xong`
              });
            }

            if(allAcked || timedOut){
              clearInterval(checkWinSync);
              if(timedOut){
                console.log(`[WIN SYNC TIMEOUT] ${roomId} - Only ${got}/${expected} acks for winning number ${num} after ${waitedForWin}ms, forcing game-won`);
              } else {
                console.log(`[WIN SYNC OK] ${roomId} - All ${got}/${expected} clients finished winning number ${num}, now emitting game-won`);
              }

              // Bây giờ mới xử lý tiền và emit game-won
              if(game.timeout) clearTimeout(game.timeout);
              
              const bet = roomData.bet_amount;
              const feePercent = roomData.fee_percent;
              const originalCount = game.originalPlayers ? game.originalPlayers.length : game.players.filter(pl=>!pl.is_bot).length;
              const forfeitedCount = game.forfeitedPlayers ? game.forfeitedPlayers.length : 0;
              const totalPlayersForPot = Math.max(game.players.filter(pl=>!pl.is_bot).length + forfeitedCount, originalCount);
              const totalPot = totalPlayersForPot * bet;
              const fee = Math.floor(totalPot * feePercent / 100);
              const winAmount = totalPot - fee;
              
              const isBotWinner = p.is_bot;
              const isDemoWinnerEarly = p.is_demo;
              
              // BOT THẮNG: trừ tiền tất cả người chơi thật (như thua người thật)
              if(isBotWinner){
                console.log(`[BOT WIN] ${roomId} - Bot ${p.bot_name} wins! Deducting ${bet} from all real players`);
                for(const pl of game.players){
                  if(pl.is_bot) continue;
                  const alreadyForfeited = game.forfeitedPlayers && game.forfeitedPlayers.some(fp => fp.user_id === pl.user_id);
                  if(alreadyForfeited) continue;
                  const prof = await getProfileById(pl.user_id);
                  if(!prof) continue;
                  const isDemoPlayer = pl.is_demo;
                  if(isDemoPlayer){
                    const newDemo = Math.max(0, (prof.demo_balance || 0) - bet);
                    await supabase.from('profiles').update({
                      demo_balance: newDemo,
                      total_wagered: (prof.total_wagered || 0) + bet
                    }).eq('id', pl.user_id);
                    await supabase.from('transactions').insert([{user_id: pl.user_id, type:'lose_demo', amount: -bet, room_id:roomId, description: `Thua ${bet} demo - bot ${p.bot_name} thắng`}]);
                  } else {
                    const newBal = (prof.balance || 0) - bet;
                    await supabase.from('profiles').update({
                      balance: newBal,
                      total_wagered: (prof.total_wagered || 0) + bet
                    }).eq('id', pl.user_id);
                    await supabase.from('transactions').insert([{user_id: pl.user_id, type:'lose', amount: -bet, room_id:roomId, description: `Thua ${bet} - bot ${p.bot_name} thắng`}]);
                  }
                }
                // Bot thắng thì pot thuộc về nhà (hoặc không ai), chỉ tính fee
                // Vẫn emit game-won để client hiển thị bot thắng
              }
              
              if(!isDemoWinnerEarly && !isBotWinner){
                for(const pl of game.players){
                  if(pl.is_bot) continue;
                  if(pl.id === p.id) continue;
                  const alreadyForfeited = game.forfeitedPlayers && game.forfeitedPlayers.some(fp => fp.user_id === pl.user_id);
                  if(alreadyForfeited) continue;
                  const prof = await getProfileById(pl.user_id);
                  if(!prof) continue;
                  const isDemoPlayer = pl.is_demo;
                  if(isDemoPlayer){
                    const newDemo = Math.max(0, (prof.demo_balance || 0) - bet);
                    await supabase.from('profiles').update({
                      demo_balance: newDemo,
                      total_wagered: (prof.total_wagered || 0) + bet
                    }).eq('id', pl.user_id);
                    await supabase.from('transactions').insert([{user_id: pl.user_id, type:'lose_demo', amount: -bet, room_id:roomId, description: `Thua ${bet} demo`}]);
                  } else {
                    const newBal = (prof.balance || 0) - bet;
                    await supabase.from('profiles').update({
                      balance: newBal,
                      total_wagered: (prof.total_wagered || 0) + bet
                    }).eq('id', pl.user_id);
                    await supabase.from('transactions').insert([{user_id: pl.user_id, type:'lose', amount: -bet, room_id:roomId}]);
                  }
                }
              }
              const winnerProf = await getProfileById(p.user_id);
              if(winnerProf){
                const isDemoWinner = p.is_demo;
                if(isDemoWinner){
                  for(const pl of game.players){
                    if(pl.is_bot) continue;
                    if(pl.id === p.id) continue;
                    const alreadyForfeited = game.forfeitedPlayers && game.forfeitedPlayers.some(fp => fp.user_id === pl.user_id);
                    if(alreadyForfeited) continue;
                    const prof = await getProfileById(pl.user_id);
                    if(!prof) continue;
                    const demoBal = prof.demo_balance || 0;
                    if(demoBal > 0){
                      const deduct = Math.min(demoBal, bet);
                      const newDemo = Math.max(0, demoBal - deduct);
                      await supabase.from('profiles').update({
                        demo_balance: newDemo,
                        total_wagered: (prof.total_wagered || 0) + deduct
                      }).eq('id', pl.user_id);
                      await supabase.from('transactions').insert([{user_id: pl.user_id, type:'lose_demo', amount: -deduct, room_id:roomId, description: `Thua ${deduct} demo (thua người chơi demo)`}]);
                    } else {
                      await supabase.from('profiles').update({
                        total_wagered: (prof.total_wagered || 0) + bet
                      }).eq('id', pl.user_id);
                    }
                  }
                  const newDemo = (winnerProf.demo_balance || 0) + winAmount;
                  await supabase.from('profiles').update({
                    demo_balance: newDemo,
                    total_wagered: (winnerProf.total_wagered || 0) + bet
                  }).eq('id', p.user_id);
                  await supabase.from('transactions').insert([{user_id: p.user_id, type:'win_demo', amount: winAmount, room_id:roomId, description: `Thắng ${winAmount} demo - người thua chỉ mất demo (nếu có)`}]);
                } else {
                  let demoPortion = 0;
                  let realPortion = winAmount;
                  if(game.forfeitedPlayers){
                    for(const fp of game.forfeitedPlayers){
                      const fpPlayer = game.originalPlayers.find(op => op.user_id === fp.user_id);
                      if(fpPlayer && fpPlayer.is_demo) demoPortion += bet;
                    }
                  }
                  for(const pl of game.players){
                    if(pl.is_bot || pl.id === p.id) continue;
                    if(pl.is_demo) demoPortion += bet;
                  }
                  realPortion = winAmount - demoPortion;
                  if(demoPortion > 0 && realPortion > 0){
                    await supabase.from('profiles').update({
                      balance: (winnerProf.balance || 0) + realPortion,
                      demo_balance: (winnerProf.demo_balance || 0) + demoPortion,
                      total_wagered: (winnerProf.total_wagered || 0) + bet
                    }).eq('id', p.user_id);
                    await supabase.from('transactions').insert([
                      {user_id: p.user_id, type:'win', amount: realPortion, room_id:roomId, description: `Thắng ${realPortion} thật + ${demoPortion} demo`},
                      {user_id: p.user_id, type:'win_demo', amount: demoPortion, room_id:roomId, description: `Thắng ${demoPortion} demo từ người chơi demo`}
                    ]);
                  } else {
                    await supabase.from('profiles').update({
                      balance: (winnerProf.balance || 0) + winAmount,
                      total_wagered: (winnerProf.total_wagered || 0) + bet
                    }).eq('id', p.user_id);
                    await supabase.from('transactions').insert([{user_id: p.user_id, type:'win', amount: winAmount, room_id:roomId}]);
                  }
                }
              }
              await supabase.from('rooms').update({status:'finished', winner_id: p.user_id || null}).eq('id',roomId);
              
              // Xóa game sau khi đã chờ xong
              activeGames.delete(roomId);
              
              // Emit game-won - lúc này tất cả máy đã quay xong số cuối
              io.to(roomId).emit('game-won', {
                winner: p, 
                number: num, 
                drawn: [...game.drawn], 
                winningRow: winInfo.row, 
                winningNumbers: winInfo.numbers, 
                winAmount, 
                fee, 
                totalPot, 
                reason:'bingo', 
                forfeitedAmount: game.forfeitedAmount || 0, 
                isDemoWin: p.is_demo,
                finalSpinCompleted: true
              });

              // Đảm bảo nút bắt đầu lại được mở cho ván mới
              io.to(roomId).emit('game-finished-can-restart', {
                roomId,
                canRestart: true,
                message: 'Ván kết thúc, có thể bắt đầu lại'
              });
            }
          }, winCheckInterval);
          
          return; // Dừng drawNext, chờ sync win
        }

        // Nếu chưa ai thắng, CHỜ ĐỦ TẤT CẢ MÁY trong phòng báo audio xong mới quay tiếp
        // Cơ chế động: phòng có bao nhiêu máy chơi thì chờ đủ bấy nhiêu máy (2 máy=>2, 3 máy=>3, 5 máy=>5...)
        // FIX SMART TIMEOUT: Nhạc Lô Tô ~30s, Giọng đọc ~2.5s
        let waited = 0;
        const checkInterval = 300;
        const audioModeForTimeout = game.audioMode || roomAudioModes.get(roomId) || "VOICE";
        const isMusicMode = audioModeForTimeout === "MUSIC";
        const maxWaitTime = isMusicMode ? 45000 : 12000; // MUSIC: 45s, VOICE: 12s
        const expectedPlayers = ()=> {
          try{
            // FIX: dùng expectedAcks đã được cập nhật động khi có người rời phòng (leave-room / disconnect)
            // game.players đã được cập nhật trong leave-room, nên nếu còn lệch thì đồng bộ lại
            if(game.players){
              const currentReal = game.players.filter(p=>!p.is_bot).length;
              if(currentReal > 0 && currentReal !== game.expectedAcks){
                console.log(`[SYNC UPDATE] ${roomId} expectedAcks ${game.expectedAcks} -> ${currentReal} (from game.players)`);
                game.expectedAcks = Math.max(1, currentReal);
              }
            }
            return Math.max(1, game.expectedAcks || 1);
          }catch(e){
            return Math.max(1, game.expectedAcks || 1);
          }
        };
        
        const checkSync = setInterval(()=>{
          if(game.isPausedForReconnect){
            return;
          }
          game.syncCheckInterval = checkSync;
          waited += checkInterval;
          const got = game.clientAcks.size;
          const expected = expectedPlayers();
          const allAcked = got >= expected;
          const timedOut = waited >= maxWaitTime;
          
          // Log mỗi 1.5s để debug
          if(waited % 1500 < checkInterval){
            console.log(`[SYNC WAIT] ${roomId} - Draw #${game.currentDrawIndex} (${game.drawn[game.drawn.length-1]}) [${audioModeForTimeout}] - Got ${got}/${expected} audio-done acks, waited ${waited}ms/${maxWaitTime}ms, need ${expected - got} more`);
            // Gửi trạng thái chờ cho clients để hiển thị
            io.to(roomId).emit('sync-waiting', {
              roomId,
              drawIndex: game.currentDrawIndex,
              number: game.drawn[game.drawn.length-1],
              got,
              expected,
              waited,
              need: expected - got
            });
          }
          
          if(allAcked){
            clearInterval(checkSync);
            if(game.syncCheckInterval){ clearInterval(game.syncCheckInterval); game.syncCheckInterval=null; }
            console.log(`[SYNC OK] ${roomId} - All ${got}/${expected} players reported audio done for draw #${game.currentDrawIndex}, drawing next in 1.2s`);
            io.to(roomId).emit('sync-complete', {
              roomId,
              drawIndex: game.currentDrawIndex,
              got,
              expected
            });
            game.waitingForAcks = false;
            game.timeout = setTimeout(drawNextWithSync, 1200);
          } else if(timedOut){
            // Timeout an toàn: nếu 1 máy disconnect, vẫn cho tiếp tục
            clearInterval(checkSync);
            if(game.syncCheckInterval){ clearInterval(game.syncCheckInterval); game.syncCheckInterval=null; }
            console.log(`[SYNC TIMEOUT] ${roomId} - Only ${got}/${expected} acks after ${waited}ms for draw #${game.currentDrawIndex}, forcing next draw (maybe player disconnected)`);
            io.to(roomId).emit('sync-timeout', {
              roomId,
              drawIndex: game.currentDrawIndex,
              got,
              expected,
              waited
            });
            game.waitingForAcks = false;
            game.timeout = setTimeout(drawNextWithSync, 1200);
          }
        }, checkInterval);
      };
      gameState.drawNext = drawNextWithSync;
      gameState.resumeDraw = drawNextWithSync;

      drawNextWithSync();

    }, 4000);
  });

  // ===== DYNAMIC SYNC HANDLERS: chờ đủ TẤT CẢ máy trong phòng (không cố định 2) =====
  // Phòng có bao nhiêu máy chơi thì chờ đủ bấy nhiêu máy: 2 máy=>2, 3 máy=>3, 4 máy=>4...
  socket.on('client-audio-done', ({roomId, userId, drawIndex, timestamp})=>{
    const game = activeGames.get(roomId);
    if(!game) return;
    if(!game.waitingForAcks){
      return;
    }
    if(typeof drawIndex === 'number' && drawIndex !== -1 && game.currentDrawIndex !== -1 && drawIndex !== game.currentDrawIndex){
      console.log(`[ACK IGNORED] ${roomId} client ${userId} ack for old drawIndex ${drawIndex}, current is ${game.currentDrawIndex}`);
      return;
    }
    const id = userId || socket.id;
    if(!game.clientAcks.has(id)){
      game.clientAcks.add(id);
      const got = game.clientAcks.size;
      const expected = game.expectedAcks;
      console.log(`[AUDIO DONE] ${roomId} - Player ${id} finished audio for draw #${game.currentDrawIndex} (number ${game.drawn[game.drawn.length-1]}), total ${got}/${expected} - Need ${expected - got} more`);
      io.to(roomId).emit('player-audio-done', {
        roomId,
        userId: id,
        drawIndex: game.currentDrawIndex,
        number: game.drawn[game.drawn.length-1],
        got,
        expected,
        need: expected - got,
        allDone: got >= expected
      });
      // Nếu đã đủ tất cả máy, log ngay
      if(got >= expected){
        console.log(`[ALL DONE] ${roomId} - Got all ${got}/${expected} audio-done acks for draw #${game.currentDrawIndex}, will draw next soon`);
      }
    } else {
      console.log(`[DUPLICATE ACK] ${roomId} - Player ${id} already acked for draw #${game.currentDrawIndex}`);
    }
  });
  socket.on('client-ready-for-next', ({roomId, userId})=>{
    const game = activeGames.get(roomId);
    if(!game) return;
    if(!game.waitingForAcks) return;
    const id = userId || socket.id;
    if(!game.clientAcks.has(id)){
      game.clientAcks.add(id);
      const got = game.clientAcks.size;
      const expected = game.expectedAcks;
      console.log(`[READY FOR NEXT] ${roomId} - Player ${id} ready, total ${got}/${expected} - Need ${expected - got} more`);
      io.to(roomId).emit('player-audio-done', {
        roomId,
        userId: id,
        drawIndex: game.currentDrawIndex,
        number: game.drawn[game.drawn.length-1],
        got,
        expected,
        need: expected - got,
        allDone: got >= expected
      });
    }
  });
  
  // ===== AUDIO MODE SYNC: chỉ chủ phòng mới được đổi =====
  socket.on('change-audio-mode', ({roomId, mode, userId})=>{
    try{
      if(!roomId || !mode) return;
      // Check host
      const hostId = roomHosts.get(roomId);
      // Try get from DB if not in cache
      supabase.from('rooms').select('host_id').eq('id', roomId).single().then(({data})=>{
        const realHostId = data ? data.host_id : hostId;
        if(realHostId && userId && realHostId !== userId){
          console.log(`[AUDIO BLOCKED] ${roomId} - ${userId} not host (${realHostId}) tried to change audio`);
          socket.emit('error', 'Chỉ chủ phòng mới được đổi chế độ âm thanh');
          return;
        }
        console.log(`[AUDIO MODE CHANGE] ${roomId} - Host ${userId} changed mode to ${mode}`);
        roomAudioModes.set(roomId, mode);
        const game = activeGames.get(roomId);
        if(game) game.audioMode = mode;
        io.to(roomId).emit('audio-mode-changed', {roomId, mode, userId});
      }).catch(()=>{
        // fallback if DB check fails
        if(hostId && userId && hostId !== userId){
          console.log(`[AUDIO BLOCKED] ${roomId} - ${userId} not host (${hostId})`);
          return socket.emit('error', 'Chỉ chủ phòng mới được đổi chế độ âm thanh');
        }
        console.log(`[AUDIO MODE CHANGE] ${roomId} - Player ${userId} changed mode to ${mode}`);
        roomAudioModes.set(roomId, mode);
        const game = activeGames.get(roomId);
        if(game) game.audioMode = mode;
        io.to(roomId).emit('audio-mode-changed', {roomId, mode, userId});
      });
    }catch(e){ console.log('change-audio-mode err', e.message); }
  });

  socket.on('get-room-audio-mode', ({roomId})=>{
    try{
      const mode = roomAudioModes.get(roomId) || "MUSIC";
      socket.emit('room-audio-mode', {roomId, mode});
    }catch(e){}
  });

  // ==== NEW: TOGGLE READY - chỉ guest, host không cần ready ====
  socket.on('toggle-ready', async ({roomId, userId, isReady})=>{
    try{
      if(!roomId || !userId) return;
      const {data: room} = await supabase.from('rooms').select('host_id').eq('id', roomId).single();
      const hostId = room ? room.host_id : roomHosts.get(roomId);
      if(hostId && hostId === userId){
        return socket.emit('error', 'Chủ phòng không cần sẵn sàng');
      }
      const game = activeGames.get(roomId);
      if(game && game.isDrawing){
        return socket.emit('error', 'Phòng đang chơi, không thể đổi trạng thái sẵn sàng');
      }
      if(!roomReadyStates.has(roomId)){
        roomReadyStates.set(roomId, new Map());
      }
      const readyMap = roomReadyStates.get(roomId);
      readyMap.set(userId, !!isReady);
      console.log(`[READY] ${roomId} - ${userId} isReady=${isReady}`);

      // Lấy username
      let username = userId.slice(0,6);
      try{
        const {data: player} = await supabase.from('room_players').select('username').eq('room_id', roomId).eq('user_id', userId).maybeSingle();
        if(player && player.username) username = player.username;
        else {
          const uname = await getUsernameById(userId);
          if(uname) username = uname;
        }
      }catch(e){}

      io.to(roomId).emit('ready-update', {roomId, userId, username, isReady: !!isReady});
      // Emit lại players-update với isReady
      const {data: players} = await supabase.from('room_players').select('*').eq('room_id', roomId);
      const playersWithReady = (players||[]).map(p=>{
        const rMap = roomReadyStates.get(roomId);
        const r = rMap ? !!rMap.get(p.user_id) : false;
        return {...p, isReady: r};
      });
      io.to(roomId).emit('players-update', playersWithReady);
    }catch(e){ console.log('toggle-ready error', e.message); }
  });

  // ==== NEW: CHANGE TICKET - đổi vé khác không cần rời phòng ====
  socket.on('change-ticket', async ({roomId, userId, ticket, ticketColor, isDemo})=>{
    try{
      if(!roomId || !userId || !ticket) return socket.emit('error','Thiếu thông tin vé');
      const game = activeGames.get(roomId);
      if(game && game.isDrawing){
        return socket.emit('error','Phòng đang quay, không thể đổi vé');
      }
      // Check trùng vé
      const {data: allPlayers} = await supabase.from('room_players').select('*').eq('room_id', roomId);
      const isTaken = (allPlayers||[]).some(p=> p.user_id !== userId && JSON.stringify(p.ticket) === JSON.stringify(ticket));
      if(isTaken){
        return socket.emit('error','Vé đã được người khác chọn, hãy chọn vé khác');
      }
      // Update DB
      const {data: updated, error} = await supabase.from('room_players').update({ticket, ticket_color: ticketColor, is_demo: !!isDemo}).eq('room_id', roomId).eq('user_id', userId).select().single();
      if(error){
        console.log('change-ticket DB error', error.message);
        return socket.emit('error','Không thể đổi vé: '+error.message);
      }
      // Reset ready khi đổi vé
      if(roomReadyStates.has(roomId)){
        roomReadyStates.get(roomId).set(userId, false);
      }
      let username = userId.slice(0,6);
      try{
        if(updated && updated.username) username = updated.username;
        else {
          const uname = await getUsernameById(userId);
          if(uname) username = uname;
        }
      }catch(e){}

      console.log(`[TICKET CHANGED] ${roomId} - ${username} (${userId}) changed ticket`);

      io.to(roomId).emit('ticket-changed', {
        roomId,
        userId,
        username,
        ticket,
        ticketColor,
        isDemo: !!isDemo
      });

      // Gửi lại danh sách players với ready reset
      const {data: players} = await supabase.from('room_players').select('*').eq('room_id', roomId);
      const playersWithReady = (players||[]).map(p=>{
        const rMap = roomReadyStates.get(roomId);
        const r = rMap ? !!rMap.get(p.user_id) : false;
        return {...p, isReady: r};
      });
      io.to(roomId).emit('players-update', playersWithReady);
      io.to(roomId).emit('ready-update', {roomId, userId, username, isReady: false});

    }catch(e){ console.log('change-ticket error', e.message); }
  });



socket.on('false-win-detected', ({roomId, winner, reason, drawnCount})=>{
    console.warn(`[FALSE WIN] ${roomId} client báo win ảo ${winner?.username||winner?.user_id} - ${reason} - drawn ${drawnCount}`);
  });
  socket.on('request-continue-game', ({roomId})=>{
    const game = activeGames.get(roomId);
    if(game && !game.isDrawing){
      console.log(`[CONTINUE] ${roomId} yêu cầu tiếp tục sau false win`);
      game.isDrawing = true;
      game.waitingForAcks = false;
      // Tiếp tục sẽ do drawNextWithSync tự chạy, ở đây chỉ reset
      if(game.clientAcks) game.clientAcks.clear();
    } else if(game && game.waitingForAcks){
      game.clientAcks.clear();
      game.waitingForAcks = false;
    }
  });

  socket.on('send-chat', async ({roomId, userId, username, text})=>{
    try{
      if(!roomId || !text) return;
      const cleanText = text.toString().trim().slice(0,200);
      if(!cleanText) return;
      const now = Date.now();
      if(socket.data.lastChat && now - socket.data.lastChat < 800){
        return socket.emit('error','Bạn chat quá nhanh!');
      }
      socket.data.lastChat = now;
      let chatUsername = username;
      if(!chatUsername && userId){
        chatUsername = await getUsernameById(userId) || 'Người chơi';
      }
      const chatData = {
        roomId,
        userId,
        username: chatUsername || 'Người chơi',
        text: cleanText,
        timestamp: new Date().toLocaleTimeString('vi-VN', {hour:'2-digit', minute:'2-digit'})
      };
      socket.to(roomId).emit('chat-message', chatData);
    }catch(e){ console.log('send-chat error', e.message); }
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
        const game = activeGames.get(leavingRoomId);
        const isPlaying = game && game.roomData && (game.roomData.status === 'playing' || game.roomData.status === 'counting');
        const betAmount = game ? game.roomData.bet_amount : null;
        
        if(isPlaying && betAmount){
          if(!game.forfeitedPlayers) game.forfeitedPlayers = [];
          if(!game.forfeitedAmount) game.forfeitedAmount = 0;
          const alreadyForfeited = game.forfeitedPlayers.some(p => p.user_id === leavingUserId);
          if(!alreadyForfeited){
            console.log(`Player ${leavingUserId} left during game ${leavingRoomId}, deducting ${betAmount}`);
            try{
              const prof = await getProfileById(leavingUserId);
              if(prof){
                const playerInGame = game.originalPlayers ? game.originalPlayers.find(pl => pl.user_id === leavingUserId) : null;
                const isDemo = playerInGame ? playerInGame.is_demo : false;
                
                if(isDemo){
                  const newDemo = Math.max(0, (prof.demo_balance || 0) - betAmount);
                  await supabase.from('profiles').update({
                    demo_balance: newDemo,
                    total_wagered: (prof.total_wagered || 0) + betAmount
                  }).eq('id', leavingUserId);
                  await supabase.from('transactions').insert([{user_id: leavingUserId, type:'forfeit_demo', amount: -betAmount, room_id: leavingRoomId, description: `Rời phòng khi đang quay - mất ${betAmount} demo`}]);
                } else {
                  if((prof.balance || 0) >= betAmount){
                    await supabase.from('profiles').update({
                      balance: prof.balance - betAmount,
                      total_wagered: (prof.total_wagered || 0) + betAmount
                    }).eq('id', leavingUserId);
                    await supabase.from('transactions').insert([{user_id: leavingUserId, type:'forfeit', amount: -betAmount, room_id: leavingRoomId, description: `Rời phòng khi đang quay - mất cược ${betAmount}`}]);
                  }
                }
                
                game.forfeitedPlayers.push({user_id: leavingUserId, username: leavingUsername, bet: betAmount, is_demo: isDemo});
                game.forfeitedAmount += betAmount;
                
                io.to(leavingRoomId).emit('player-forfeited', {
                  userId: leavingUserId, 
                  username: leavingUsername || 'Người chơi',
                  forfeitedAmount: betAmount,
                  totalForfeited: game.forfeitedAmount,
                  isDemo: isDemo,
                  message: `${leavingUsername || 'Người chơi'} đã rời phòng khi đang quay, mất ${betAmount.toLocaleString()} xu ${isDemo ? '(demo)' : ''} vào pot!`
                });
                io.to(leavingRoomId).emit('toast', {message: `${leavingUsername || 'Người chơi'} rời phòng khi đang quay, ${betAmount.toLocaleString()} xu ${isDemo ? 'demo' : ''} của họ sẽ cộng cho người thắng!`, type:'warning'});
              }
            }catch(e){ console.log('forfeit deduct error', e.message); }
          }
        }
        
        await supabase.from('room_players').delete().eq('room_id', leavingRoomId).eq('user_id', leavingUserId);
        io.to(leavingRoomId).emit('player-left', {userId: leavingUserId, username: leavingUsername || 'Người chơi', roomId: leavingRoomId, wasPlaying: !!isPlaying, forfeited: isPlaying ? betAmount : 0});
        const {data: remainingPlayers} = await supabase.from('room_players').select('*').eq('room_id', leavingRoomId);
        io.to(leavingRoomId).emit('players-update', remainingPlayers);

        // ===== FIX SYNC: khi rời phòng trong lúc đang quay, loại khỏi danh sách chờ audio =====
        if(game){
          try{
            // cập nhật RAM players để vòng quay sau dùng danh sách mới
            game.players = remainingPlayers ? [...remainingPlayers] : [];
            // loại user rời khỏi ack set nếu đã ack trước đó (tránh treo đếm ack ảo)
            if(game.clientAcks){
              if(game.clientAcks.has(leavingUserId)) game.clientAcks.delete(leavingUserId);
              // cũng xóa theo socket.id nếu trùng (phòng thủ)
              if(game.clientAcks.has(leavingUserId.toString())) game.clientAcks.delete(leavingUserId.toString());
            }
            const stillReal = remainingPlayers ? remainingPlayers.filter(p=>!p.is_bot).length : 0;
            if(stillReal === 0){
              console.log(`[LEAVE SYNC] ${leavingRoomId} - No real players left after ${leavingUserId} left, clearing sync`);
              game.expectedAcks = 0;
              if(game.clientAcks) game.clientAcks.clear();
              game.waitingForAcks = false;
              io.to(leavingRoomId).emit('sync-complete', {roomId: leavingRoomId, reason:'no_real_players', got:0, expected:0});
              io.to(leavingRoomId).emit('sync-waiting', {roomId: leavingRoomId, got:0, expected:0, need:0});
            } else {
              const newExpected = Math.max(1, stillReal);
              if(newExpected !== game.expectedAcks){
                console.log(`[LEAVE SYNC] ${leavingRoomId} - Player ${leavingUserId} (${leavingUsername}) left, expectedAcks ${game.expectedAcks} -> ${newExpected} (remaining real: ${stillReal})`);
                game.expectedAcks = newExpected;
              }
              if(game.waitingForAcks){
                io.to(leavingRoomId).emit('sync-waiting', {
                  roomId: leavingRoomId,
                  drawIndex: game.currentDrawIndex,
                  number: game.drawn && game.drawn.length>0 ? game.drawn[game.drawn.length-1] : null,
                  got: game.clientAcks ? game.clientAcks.size : 0,
                  expected: game.expectedAcks,
                  need: Math.max(0, game.expectedAcks - (game.clientAcks ? game.clientAcks.size : 0))
                });
                if(game.clientAcks && game.clientAcks.size >= game.expectedAcks){
                  console.log(`[LEAVE SYNC] ${leavingRoomId} - After leave, enough acks ${game.clientAcks.size}/${game.expectedAcks}, will force next draw`);
                  io.to(leavingRoomId).emit('sync-complete', {
                    roomId: leavingRoomId,
                    got: game.clientAcks.size,
                    expected: game.expectedAcks,
                    reason: 'player_left_enough'
                  });
                }
              }
            }
          }catch(e){ console.log('[LEAVE SYNC] error', e.message); }
        }

        // ===== FIX: NẾU PHÒNG TRỐNG -> XÓA LUÔN KHỎI DB =====
        if(!remainingPlayers || remainingPlayers.length === 0){
          const realRemaining = remainingPlayers ? remainingPlayers.filter(p=>!p.is_bot).length : 0;
          if(realRemaining === 0){
            await supabase.from('rooms').delete().eq('id', leavingRoomId);
            activeGames.delete(leavingRoomId);
            console.log(`[LEAVE CLEANUP] Phòng ${leavingRoomId} trống -> đã xóa`);
          }
        }

        if(game && game.players){
          const stillInRoom = remainingPlayers.filter(p=>!p.is_bot);
          if(stillInRoom.length === 0 && game.roomData && game.roomData.status !== 'finished'){
            console.log(`[BOT ONLY] Room ${leavingRoomId || roomId} - No real players left, ending game to avoid sync hang 0/1`);
            if(game.interval) clearInterval(game.interval);
            if(game.timeout) clearTimeout(game.timeout);
            if(game.clientAcks) game.clientAcks.clear();
            game.waitingForAcks = false;
            activeGames.delete(leavingRoomId || roomId);
            try{
              await supabase.from('rooms').update({status:'finished'}).eq('id', leavingRoomId || roomId);
            }catch(e){}
            io.to(leavingRoomId || roomId).emit('game-ended', {reason:'all_left', message:'Tất cả người chơi đã rời phòng'});
            io.to(leavingRoomId || roomId).emit('sync-complete', {roomId: leavingRoomId || roomId, reason:'no_real_players', got:0, expected:0});
            io.to(leavingRoomId || roomId).emit('room-closed', {roomId: leavingRoomId || roomId, reason:'no_players'});
          } else if(stillInRoom.length === 1 && game.roomData && game.roomData.status !== 'finished'){
            console.log(`Only 1 player left in room ${leavingRoomId}, auto win for ${stillInRoom[0].user_id}`);
            clearInterval(game.interval);
            activeGames.delete(leavingRoomId);
            const bet = game.roomData.bet_amount;
            const feePercent = game.roomData.fee_percent;
            const originalCount = game.originalPlayers ? game.originalPlayers.length : (remainingPlayers.length + 1 + (game.forfeitedPlayers ? game.forfeitedPlayers.length : 0));
            const totalPot = originalCount * bet;
            const fee = Math.floor(totalPot * feePercent / 100);
            const winAmount = totalPot - fee;
            const winner = stillInRoom[0];
            // UPDATED per new spec: demo win -> losers only lose demo (if have)
            if(winner.is_demo){
              for(const pl of game.originalPlayers){
                if(pl.user_id && pl.user_id !== winner.user_id){
                  const alreadyDeducted = game.forfeitedPlayers && game.forfeitedPlayers.some(fp => fp.user_id === pl.user_id);
                  if(!alreadyDeducted){
                    const prof = await getProfileById(pl.user_id);
                    if(prof){
                      const demoBal = prof.demo_balance || 0;
                      if(demoBal > 0){
                        const deduct = Math.min(demoBal, bet);
                        await supabase.from('profiles').update({demo_balance: Math.max(0, demoBal-deduct), total_wagered: (prof.total_wagered||0)+deduct}).eq('id',pl.user_id);
                        await supabase.from('transactions').insert([{user_id: pl.user_id, type:'forfeit_demo', amount: -deduct, room_id: leavingRoomId, description: 'Thua demo (thua người chơi demo - last man)'}]);
                      } else {
                        await supabase.from('profiles').update({total_wagered: (prof.total_wagered||0)+bet}).eq('id',pl.user_id);
                      }
                    }
                  }
                }
              }
            } else {
              for(const pl of game.originalPlayers){
                if(pl.user_id && pl.user_id !== winner.user_id){
                  const alreadyDeducted = game.forfeitedPlayers && game.forfeitedPlayers.some(fp => fp.user_id === pl.user_id);
                  if(!alreadyDeducted){
                    const prof = await getProfileById(pl.user_id);
                    if(prof){
                      if(pl.is_demo){
                        await supabase.from('profiles').update({demo_balance: Math.max(0, (prof.demo_balance||0)-bet), total_wagered: (prof.total_wagered||0)+bet}).eq('id',pl.user_id);
                      } else {
                        await supabase.from('profiles').update({balance: (prof.balance||0)-bet, total_wagered: (prof.total_wagered||0)+bet}).eq('id',pl.user_id);
                      }
                      await supabase.from('transactions').insert([{user_id: pl.user_id, type:'forfeit', amount: -bet, room_id: leavingRoomId}]);
                    }
                  }
                }
              }
            }
            const winnerProf = await getProfileById(winner.user_id);
            if(winnerProf){
              if(winner.is_demo){
                await supabase.from('profiles').update({demo_balance: (winnerProf.demo_balance||0)+winAmount, total_wagered: (winnerProf.total_wagered||0)+bet}).eq('id',winner.user_id);
                await supabase.from('transactions').insert([{user_id: winner.user_id, type:'win_demo', amount: winAmount, room_id:leavingRoomId, description: 'Thắng demo last man - người thua chỉ mất demo nếu có'}]);
              } else {
                await supabase.from('profiles').update({balance: (winnerProf.balance||0)+winAmount, total_wagered: (winnerProf.total_wagered||0)+bet}).eq('id',winner.user_id);
                await supabase.from('transactions').insert([{user_id: winner.user_id, type:'win', amount: winAmount, room_id:leavingRoomId}]);
              }
            }
            await supabase.from('transactions').insert([{user_id: winner.user_id, type:'win', amount: winAmount, room_id:leavingRoomId}]);
            await supabase.from('rooms').update({status:'finished', winner_id: winner.user_id}).eq('id',leavingRoomId);
            io.to(leavingRoomId).emit('game-won', {winner: winner, winAmount, fee, totalPot, reason:'last_man_standing', leftCount: originalCount -1, forfeitedAmount: game.forfeitedAmount || 0});
            io.to(leavingRoomId).emit('toast', {message: `Người chơi cuối cùng ${winner.username || 'Bạn'} thắng ${winAmount.toLocaleString()} xu vì mọi người đã rời phòng!`, type:'success'});
          } else if(isPlaying && stillInRoom.length > 1){
            const originalCount = game.originalPlayers ? game.originalPlayers.length : (remainingPlayers.length + (game.forfeitedPlayers ? game.forfeitedPlayers.length : 0) + 1);
            const totalPot = originalCount * betAmount;
            io.to(leavingRoomId).emit('pot-updated', {totalPot, forfeitedAmount: game.forfeitedAmount || 0, remainingCount: stillInRoom.length});
          }
        }
      }
    }catch(e){ console.log('leave-room error', e.message); }
  });

  socket.on('disconnect', async ()=>{
    try{
      const userId = socket.data.userId;
      const roomId = socket.data.roomId;
      if(!userId || !roomId) return;
      
      const username = await getUsernameById(userId) || 'Người chơi';
      const game = activeGames.get(roomId);
      const isPlaying = game && game.roomData && (game.roomData.status === 'playing' || game.roomData.status === 'counting');
      
      const key = getReconnectKey(roomId, userId);
      if(reconnectingPlayers.has(key)){
        console.log(`[DISCONNECT] ${roomId} - ${userId} already in reconnecting map, skip duplicate`);
        return;
      }
      
      console.log(`[DISCONNECT] ${roomId} - ${userId} (${username}) disconnected, starting grace ${MAX_RECONNECT_ATTEMPTS}x${RECONNECT_GRACE_MS}ms, isPlaying=${!!isPlaying}`);
      
      reconnectingPlayers.set(key, {
        attempt: 1,
        timer: null,
        username,
        roomId,
        userId,
        disconnectedAt: Date.now()
      });
      
      io.to(roomId).emit('player-disconnected', {
        userId,
        username,
        roomId,
        attempt: 1,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        graceMs: RECONNECT_GRACE_MS,
        isPlaying: !!isPlaying,
        message: `📡 ${username} mất kết nối, đang thử lại 1/${MAX_RECONNECT_ATTEMPTS}...`
      });
      io.to(roomId).emit('player-reconnecting', {
        userId,
        username,
        roomId,
        attempt: 1,
        maxAttempts: MAX_RECONNECT_ATTEMPTS,
        message: `📡 ${username} mất kết nối, đang thử lại 1/${MAX_RECONNECT_ATTEMPTS}...`
      });
      io.to(roomId).emit('toast', {message: `📡 ${username} mất kết nối, đang thử lại 1/${MAX_RECONNECT_ATTEMPTS} (${RECONNECT_GRACE_MS/1000}s)...`, type:'warning'});
      
      if(game){
        try{
          const {data: remainingPlayers} = await supabase.from('room_players').select('*').eq('room_id', roomId);
          const realCount = remainingPlayers ? remainingPlayers.filter(p=>!p.is_bot).length : 1;
          const isSoloRoom = roomId.startsWith('SOLO-') || realCount <= 1;
          
          if(isSoloRoom){
            console.log(`[DISCONNECT SOLO PAUSE] ${roomId} - Solo player ${userId} disconnected, pausing game`);
            game.isPausedForReconnect = true;
            game.waitingForReconnect = true;
            if(game.timeout){ clearTimeout(game.timeout); game.timeout = null; }
            if(game.interval){ clearInterval(game.interval); game.interval = null; }
            if(game.syncCheckInterval){ clearInterval(game.syncCheckInterval); game.syncCheckInterval = null; }
            game.waitingForAcks = false;
            
            io.to(roomId).emit('game-paused-reconnect', {
              roomId,
              userId,
              username: username || 'Người chơi',
              isSolo: true,
              drawnCount: game.drawn ? game.drawn.length : 0,
              message: `⏸️ Game tạm dừng vì bạn mất kết nối. Đang chờ kết nối lại ${MAX_RECONNECT_ATTEMPTS}x${RECONNECT_GRACE_MS/1000}s...`,
              reason: 'solo_disconnect_pause'
            });
            io.to(roomId).emit('sync-waiting', {
              roomId,
              drawIndex: game.currentDrawIndex,
              number: game.drawn && game.drawn.length>0 ? game.drawn[game.drawn.length-1] : null,
              got: 0,
              expected: 1,
              need: 0,
              reconnecting: true,
              isPaused: true,
              isSolo: true,
              disconnectedUserId: userId,
              message: 'Tạm dừng chờ reconnect'
            });
            io.to(roomId).emit('toast', {message: `⏸️ Solo tạm dừng vì mất mạng, chờ reconnect ${MAX_RECONNECT_ATTEMPTS} lần...`, type:'warning'});
          } else {
            if(realCount > 1){
              const newExpected = Math.max(1, realCount - 1);
              if(!game._originalExpectedAcks) game._originalExpectedAcks = game.expectedAcks;
              console.log(`[DISCONNECT SYNC] ${roomId} - ${userId} disconnected, expectedAcks ${game.expectedAcks} -> ${newExpected} (excluding disconnected)`);
              game.expectedAcks = newExpected;
            }
            if(game.clientAcks && game.clientAcks.has(userId)){
              game.clientAcks.delete(userId);
            }
            io.to(roomId).emit('sync-waiting', {
              roomId,
              drawIndex: game.currentDrawIndex,
              number: game.drawn && game.drawn.length>0 ? game.drawn[game.drawn.length-1] : null,
              got: game.clientAcks ? game.clientAcks.size : 0,
              expected: game.expectedAcks,
              need: Math.max(0, game.expectedAcks - (game.clientAcks ? game.clientAcks.size : 0)),
              reconnecting: true,
              disconnectedUserId: userId
            });
            if(game.waitingForAcks && game.clientAcks && game.clientAcks.size >= game.expectedAcks){
              io.to(roomId).emit('sync-complete', {roomId, got: game.clientAcks.size, expected: game.expectedAcks, reason:'player_disconnected_enough'});
            }
          }
        }catch(e){ console.log('disconnect sync error', e.message); }
      }
      
      scheduleReconnectCheck(roomId, userId, username);
      
    }catch(e){ console.log('disconnect error', e.message); }
  });

});

// ===== AUTO CLEANUP: XÓA PHÒNG TRỐNG + PHÒNG CŨ KẸT =====
async function cleanupEmptyRooms(){
  try{
    const {data: allRooms} = await supabase.from('rooms').select('id, created_at, updated_at, status').neq('status','finished').limit(150);
    if(!allRooms || allRooms.length===0) return;
    const now = Date.now();
    
    for(const room of allRooms){
      if(room.id && room.id.startsWith('SOLO-')) continue;
      const createdAt = new Date(room.created_at);
      const updatedAt = room.updated_at ? new Date(room.updated_at) : createdAt;
      const ageMinutes = (now - createdAt.getTime()) / 1000 / 60;
      const idleMinutes = (now - updatedAt.getTime()) / 1000 / 60;

      // Bỏ qua phòng mới tạo < 3 phút
      if(ageMinutes < 3) continue;

      const {data: players, error} = await supabase.from('room_players').select('id, is_bot').eq('room_id', room.id);
      if(error) continue;
      const total = players ? players.length : 0;
      const realCount = players ? players.filter(p=>!p.is_bot).length : 0;
      const game = activeGames.get(room.id);
      
      // 1. Phòng 0 người -> xóa luôn
      if(total === 0){
        await supabase.from('rooms').delete().eq('id', room.id);
        activeGames.delete(room.id);
        console.log(`[CLEANUP] Xóa phòng trống hoàn toàn ${room.id}`);
        continue;
      }
      // 2. Phòng chỉ có bot -> xóa sau 10 phút idle
      if(realCount === 0){
        if(!game || !game.isDrawing){
          if(idleMinutes > 10){
            await supabase.from('room_players').delete().eq('room_id', room.id);
            await supabase.from('rooms').delete().eq('id', room.id);
            activeGames.delete(room.id);
            console.log(`[CLEANUP] Xóa phòng không có người thật ${room.id}`);
          }
        }
        continue;
      }
      // 3. Phòng chờ (waiting) mà tạo quá 90 phút và vẫn < 2 người -> dọn (bị kẹt từ 17/08)
      if(room.status === 'waiting' && ageMinutes > 90 && realCount < 2){
        await supabase.from('room_players').delete().eq('room_id', room.id);
        await supabase.from('rooms').update({status:'finished'}).eq('id', room.id);
        // hoặc delete hẳn:
        // await supabase.from('rooms').delete().eq('id', room.id);
        console.log(`[CLEANUP] Dọn phòng chờ kẹt >90p ${room.id} (${realCount} người)`);
        continue;
      }
      // 4. Phòng đang playing nhưng không có trong activeGames (server restart) và idle > 30p -> finished
      if(room.status === 'playing' && !game && idleMinutes > 30){
        await supabase.from('rooms').update({status:'finished'}).eq('id', room.id);
        console.log(`[CLEANUP] Kết thúc phòng playing kẹt ${room.id} (không có game trong RAM)`);
      }
    }
  }catch(e){
    console.log('[CLEANUP-JOB] error', e.message);
  }
}
// Chạy mỗi 1 phút
setInterval(cleanupEmptyRooms, 60*1000);
// Chạy ngay sau khi khởi động 10s
setTimeout(cleanupEmptyRooms, 10000);


app.get('/', (req,res)=> res.send('Loto Online Backend Running - Demo Balance + Withdraw + Admin System - Updated Demo Win Logic'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Server running on '+PORT));
