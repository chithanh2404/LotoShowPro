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
  const {data, error} = await supabase.from('rooms').insert({id, name, host_id:hostId, password: password||null, bet_amount:betAmount, max_players:maxPlayers||5, fee_percent:fee, status:'waiting'}).select().single();
  if(error) return res.status(500).json({error});
  const finalTicket = ticket || generateLotoTicket();
  const username = await getUsernameById(hostId);
  const ticketColor = req.body.ticketColor || '#00d2ff';
  const is_demo = !!isDemo;
  await supabase.from('room_players').insert({room_id:id, user_id:hostId, username: username, ticket: finalTicket, ticket_color: ticketColor, is_bot:false, is_demo});
  res.json(data);
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
    res.json({...room, players, hasBots, realPlayersCount: realPlayers.length, totalPlayers: players ? players.length : 0});
  }catch(e){
    res.status(500).json({error: e.message});
  }
});

// ===== SOCKET.IO GAME LOOP =====
const activeGames = new Map();
const roomAudioModes = new Map(); // audio mode sync

io.on('connection', (socket)=>{
  console.log('socket connected', socket.id);

  socket.on('join-room', async ({roomId, userId, password, ticket, ticketColor, isDemo})=>{
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
      const is_demo = !!isDemo;
      await supabase.from('room_players').insert({room_id:roomId, user_id:userId, username: username, ticket: finalTicket, ticket_color: color, is_bot:false, is_demo});
    } else if(existList.length>1){
      for(let i=1;i<existList.length;i++){
        await supabase.from('room_players').delete().eq('id', existList[i].id);
      }
    }
    const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
    io.to(roomId).emit('players-update', players);
    io.to(roomId).emit('room-info', room);
    const currentAudioMode = roomAudioModes.get(roomId) || room.audio_mode || "MUSIC";
    io.to(roomId).emit('room-audio-mode', {roomId, mode: currentAudioMode});
    socket.emit('room-audio-mode', {roomId, mode: currentAudioMode});
    const joinedPlayer = players.find(p=>p.user_id===userId);
    const joinedUsername = joinedPlayer ? (joinedPlayer.username || await getUsernameById(userId) || 'Người chơi') : (await getUsernameById(userId) || 'Người chơi');
    io.to(roomId).emit('player-joined', {userId, username: joinedUsername, roomId});
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

    socket.on('start-game', async ({roomId})=>{
    if(activeGames.has(roomId)) return;
    await supabase.from('rooms').update({status:'counting'}).eq('id',roomId);
    io.to(roomId).emit('countdown-start');
    setTimeout(async ()=>{
      await supabase.from('rooms').update({status:'playing', current_numbers:[]}).eq('id',roomId);
      const allNumbers = Array.from({length:90},(_,i)=>i+1).sort(()=>Math.random()-0.5);
      const drawn = [];
      const drawnSet = new Set();
      const {data: players} = await supabase.from('room_players').select('*').eq('room_id',roomId);
      const {data: roomData} = await supabase.from('rooms').select('*').eq('id',roomId).single();
      // FIX SYNC: thêm clientAcks và barrier để chờ tất cả máy đọc xong mới ra số tiếp
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
        expectedAcks: players.filter(p=>!p.is_bot).length,
        audioMode: roomAudioModes.get(roomId) || "MUSIC",
        isDrawing: true,
        waitingForAcks: false,
        timeout: null,
        interval: null
      };
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
        game.clientAcks.clear();
        game.waitingForAcks = true;

        await supabase.from('rooms').update({current_numbers: game.drawn}).eq('id',roomId);
        const currentRoomAudioMode = game.audioMode || roomAudioModes.get(roomId) || "MUSIC";
        io.to(roomId).emit('number-drawn', {number:num, drawn: [...game.drawn], audioVariant, drawIndex: game.drawn.length-1, roomId, audioMode: currentRoomAudioMode});

        // Kiểm tra thắng với logic FIX (đủ 5 số 1 hàng)
        for(const p of game.players){
          if(p.is_bot) continue;
          const winInfo = getWinningRowInfo(p.ticket, game.drawnSet);
          if(winInfo){
            game.isDrawing = false;
            if(game.timeout) clearTimeout(game.timeout);
            activeGames.delete(roomId);
            const bet = roomData.bet_amount;
            const feePercent = roomData.fee_percent;
            const originalCount = game.originalPlayers ? game.originalPlayers.length : game.players.filter(pl=>!pl.is_bot).length;
            const forfeitedCount = game.forfeitedPlayers ? game.forfeitedPlayers.length : 0;
            const totalPlayersForPot = Math.max(game.players.filter(pl=>!pl.is_bot).length + forfeitedCount, originalCount);
            const totalPot = totalPlayersForPot * bet;
            const fee = Math.floor(totalPot * feePercent / 100);
            const winAmount = totalPot - fee;
            
            const isDemoWinnerEarly = p.is_demo;
            if(!isDemoWinnerEarly){
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
            io.to(roomId).emit('game-won', {winner: p, number: num, drawn: [...game.drawn], winningRow: winInfo.row, winningNumbers: winInfo.numbers, winAmount, fee, totalPot, reason:'bingo', forfeitedAmount: game.forfeitedAmount || 0, isDemoWin: p.is_demo});
            break;
          }
        }

        // Nếu chưa ai thắng, chờ đồng bộ tất cả thiết bị (fix nhảy số)
        let waited = 0;
        // Cập nhật expectedAcks theo số người chơi hiện tại còn trong phòng
        const updateExpected = ()=>{
          try{
            const currentPlayers = game.players ? game.players.filter(p=>!p.is_bot) : [];
            // Nếu có forfeited, trừ đi
            const activeCount = currentPlayers.length;
            // Lấy số người thực tế đang trong phòng (từ room_players nếu có)
            return Math.max(1, activeCount);
          }catch(e){ return Math.max(1, game.expectedAcks || 1); }
        };
        const checkSync = setInterval(()=>{
          waited += 300;
          const got = game.clientAcks.size;
          const expected = updateExpected();
          // Log để debug
          if(waited % 1500 < 300){
            console.log(`[SYNC WAIT] ${roomId} got ${got}/${expected} acks, waited ${waited}ms`);
          }
          // Chờ đủ ack hoặc timeout 15s (tăng từ 7s để đủ thời gian đọc số)
          if(got >= expected || waited >= 15000){
            clearInterval(checkSync);
            if(got < expected){
              console.log(`[SYNC TIMEOUT] ${roomId} only ${got}/${expected} acks after ${waited}ms, continuing anyway`);
            } else {
              console.log(`[SYNC OK] ${roomId} all ${got}/${expected} clients ready, drawing next`);
            }
            game.waitingForAcks = false;
            game.timeout = setTimeout(drawNextWithSync, 1200);
          }
        }, 300);
      };

      drawNextWithSync();

    }, 4000);
  });

  // ===== FIX SYNC HANDLERS - đảm bảo các máy đợi nhau cùng quay =====
  socket.on('client-audio-done', ({roomId, userId, drawIndex})=>{
    const game = activeGames.get(roomId);
    if(!game) return;
    const id = userId || socket.id;
    if(!game.clientAcks.has(id)){
      game.clientAcks.add(id);
      console.log(`[ACK] ${roomId} client ${id} done audio drawIndex ${drawIndex}, total ${game.clientAcks.size}/${game.expectedAcks}`);
    }
  });
  socket.on('client-ready-for-next', ({roomId, userId})=>{
    const game = activeGames.get(roomId);
    if(!game) return;
    const id = userId || socket.id;
    if(!game.clientAcks.has(id)){
      game.clientAcks.add(id);
      console.log(`[ACK-READY] ${roomId} client ${id} ready, total ${game.clientAcks.size}/${game.expectedAcks}`);
    }
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


  socket.on('change-audio-mode', ({roomId, mode, userId})=>{
    try{
      if(!roomId || !mode) return;
      roomAudioModes.set(roomId, mode);
      const game = activeGames.get(roomId);
      if(game) game.audioMode = mode;
      io.to(roomId).emit('audio-mode-changed', {roomId, mode});
    }catch(e){}
  });

  socket.on('get-room-audio-mode', ({roomId})=>{
    try{
      const mode = roomAudioModes.get(roomId) || "MUSIC";
      socket.emit('room-audio-mode', {roomId, mode});
    }catch(e){}
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

        if(game && game.players){
          const stillInRoom = remainingPlayers.filter(p=>!p.is_bot);
          if(stillInRoom.length === 1 && game.roomData && game.roomData.status !== 'finished'){
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
      if(userId && roomId){
        const game = activeGames.get(roomId);
        const isPlaying = game && game.roomData && (game.roomData.status === 'playing' || game.roomData.status === 'counting');
        const betAmount = game ? game.roomData.bet_amount : null;
        
        if(isPlaying && betAmount){
          if(!game.forfeitedPlayers) game.forfeitedPlayers = [];
          if(!game.forfeitedAmount) game.forfeitedAmount = 0;
          const alreadyForfeited = game.forfeitedPlayers.some(p => p.user_id === userId);
          if(!alreadyForfeited){
            try{
              const prof = await getProfileById(userId);
              if(prof){
                const playerInGame = game.originalPlayers ? game.originalPlayers.find(pl => pl.user_id === userId) : null;
                const isDemo = playerInGame ? playerInGame.is_demo : false;
                if(isDemo){
                  await supabase.from('profiles').update({demo_balance: Math.max(0,(prof.demo_balance||0)-betAmount), total_wagered: (prof.total_wagered||0)+betAmount}).eq('id', userId);
                } else {
                  if((prof.balance||0) >= betAmount){
                    await supabase.from('profiles').update({balance: prof.balance - betAmount, total_wagered: (prof.total_wagered||0)+betAmount}).eq('id', userId);
                  }
                }
                await supabase.from('transactions').insert([{user_id: userId, type:'forfeit', amount: -betAmount, room_id: roomId, description: `Mất kết nối khi đang quay - mất cược`}]);
                const username = await getUsernameById(userId);
                game.forfeitedPlayers.push({user_id: userId, username: username, bet: betAmount, is_demo: isDemo});
                game.forfeitedAmount += betAmount;
                io.to(roomId).emit('player-forfeited', {userId, username: username || 'Người chơi', forfeitedAmount: betAmount, totalForfeited: game.forfeitedAmount, isDemo});
              }
            }catch(e){ console.log('disconnect forfeit error', e.message); }
          }
        }
        
        const username = await getUsernameById(userId);
        await supabase.from('room_players').delete().eq('room_id', roomId).eq('user_id', userId);
        io.to(roomId).emit('player-left', {userId, username: username || 'Người chơi', roomId, wasPlaying: !!isPlaying});
        const {data: remainingPlayers} = await supabase.from('room_players').select('*').eq('room_id', roomId);
        io.to(roomId).emit('players-update', remainingPlayers);
        if(game){
          const stillInRoom = remainingPlayers.filter(p=>!p.is_bot);
          if(stillInRoom.length === 1 && game.roomData && game.roomData.status !== 'finished'){
            clearInterval(game.interval);
            activeGames.delete(roomId);
            const bet = game.roomData.bet_amount;
            const feePercent = game.roomData.fee_percent;
            const originalCount = game.originalPlayers ? game.originalPlayers.length : (remainingPlayers.length + 1 + (game.forfeitedPlayers ? game.forfeitedPlayers.length : 0));
            const totalPot = originalCount * bet;
            const fee = Math.floor(totalPot * feePercent / 100);
            const winAmount = totalPot - fee;
            const winner = stillInRoom[0];
            // UPDATED per new spec for disconnect last man
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
                        await supabase.from('transactions').insert([{user_id: pl.user_id, type:'forfeit_demo', amount: -deduct, room_id: roomId, description: 'Thua demo last man disconnect'}]);
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
                        await supabase.from('profiles').update({demo_balance: Math.max(0,(prof.demo_balance||0)-bet), total_wagered: (prof.total_wagered||0)+bet}).eq('id',pl.user_id);
                      } else {
                        await supabase.from('profiles').update({balance: (prof.balance||0)-bet, total_wagered: (prof.total_wagered||0)+bet}).eq('id',pl.user_id);
                      }
                      await supabase.from('transactions').insert([{user_id: pl.user_id, type:'forfeit', amount: -bet, room_id: roomId}]);
                    }
                  }
                }
              }
            }
            const winnerProf = await getProfileById(winner.user_id);
            if(winnerProf){
              if(winner.is_demo){
                await supabase.from('profiles').update({demo_balance: (winnerProf.demo_balance||0)+winAmount, total_wagered: (winnerProf.total_wagered||0)+bet}).eq('id',winner.user_id);
                await supabase.from('transactions').insert([{user_id: winner.user_id, type:'win_demo', amount: winAmount, room_id:roomId, description: 'Thắng demo last man disconnect - người thua chỉ mất demo nếu có'}]);
              } else {
                await supabase.from('profiles').update({balance: (winnerProf.balance||0)+winAmount, total_wagered: (winnerProf.total_wagered||0)+bet}).eq('id',winner.user_id);
                await supabase.from('transactions').insert([{user_id: winner.user_id, type:'win', amount: winAmount, room_id:roomId}]);
              }
            }
            await supabase.from('rooms').update({status:'finished', winner_id: winner.user_id}).eq('id',roomId);
            io.to(roomId).emit('game-won', {winner, winAmount, fee, totalPot, reason:'last_man_standing', forfeitedAmount: game.forfeitedAmount || 0, isDemoWin: winner.is_demo});
          }
        }
      }
    }catch(e){ console.log('disconnect error', e.message); }
  });

});

app.get('/', (req,res)=> res.send('Loto Online Backend Running - Demo Balance + Withdraw + Admin System - Updated Demo Win Logic'));

const PORT = process.env.PORT || 3000;
server.listen(PORT, ()=> console.log('Server running on '+PORT));
