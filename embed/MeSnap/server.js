const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const createPokerService = require('./poker-server');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const JWT_SECRET = 'your-super-secret-key-change-this-in-production';
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// IP capture middleware
app.use((req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
               req.headers['x-real-ip'] ||
               req.socket.remoteAddress ||
               req.connection.remoteAddress;
    req.clientIp = ip;
    next();
});

// IP ban check middleware
app.use((req, res, next) => {
    const ip = req.clientIp;
    db.get('SELECT * FROM ip_bans WHERE ip_address = ?', [ip], (err, ban) => {
        if (ban) {
            return res.status(403).json({ error: 'Your IP address has been banned', reason: ban.reason });
        }
        next();
    });
});

// Device fingerprint generation function
const generateDeviceFingerprint = (req) => {
    const crypto = require('crypto');
    const userAgent = req.headers['user-agent'] || '';
    const screenRes = req.body?.screenRes || 'unknown';
    const timezone = req.body?.timezone || 'unknown';
    const language = req.body?.language || 'unknown';
    
    const fingerprintData = `${userAgent}|${screenRes}|${timezone}|${language}`;
    return crypto.createHash('sha256').update(fingerprintData).digest('hex');
};

// Hardware ban check middleware
app.use((req, res, next) => {
    // Skip hardware ban check for non-auth routes
    if (!req.path.includes('/api/auth/') && !req.path.includes('/api/verify')) {
        return next();
    }
    
    const fingerprint = generateDeviceFingerprint(req);
    db.get('SELECT * FROM hardware_bans WHERE fingerprint = ?', [fingerprint], (err, ban) => {
        if (ban) {
            return res.status(403).json({ error: 'Your device has been banned', reason: ban.reason });
        }
        req.deviceFingerprint = fingerprint;
        next();
    });
});

app.use((req, res, next) => {
    let filename;
    try {
        filename = path.basename(decodeURIComponent(req.path));
    } catch (error) {
        return next(error);
    }
    if (/^mesnap\.db(?:-(?:journal|shm|wal))?$/i.test(filename)) return res.sendStatus(404);
    next();
});

app.use(express.static(path.join(__dirname)));

// Database setup
const db = new sqlite3.Database('./mesnap.db', (err) => {
    if (err) console.error(err);
    else console.log('Connected to SQLite database');
});

// Create tables
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER NOT NULL,
        text TEXT,
        image TEXT,
        read BOOLEAN DEFAULT 0,
        opened_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(sender_id) REFERENCES users(id),
        FOREIGN KEY(receiver_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS friendships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        friend_id INTEGER NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        FOREIGN KEY(friend_id) REFERENCES users(id),
        UNIQUE(user_id, friend_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_status (
        user_id INTEGER PRIMARY KEY,
        typing_with INTEGER,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS ip_bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT UNIQUE NOT NULL,
        reason TEXT,
        banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        banned_by_user_id INTEGER,
        FOREIGN KEY(banned_by_user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_ips (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        ip_address TEXT NOT NULL,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS device_fingerprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        user_agent TEXT,
        screen_res TEXT,
        timezone TEXT,
        language TEXT,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id),
        UNIQUE(user_id, fingerprint)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS hardware_bans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fingerprint TEXT UNIQUE NOT NULL,
        reason TEXT,
        banned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        banned_by_user_id INTEGER,
        FOREIGN KEY(banned_by_user_id) REFERENCES users(id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS site_visitors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ip_address TEXT NOT NULL,
        fingerprint TEXT,
        user_agent TEXT,
        screen_res TEXT,
        timezone TEXT,
        language TEXT,
        page_visited TEXT DEFAULT '/index.html',
        visited_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

createPokerService({ app, io, db });

// Helper functions
function generateToken(userId) {
    return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET);
    } catch {
        return null;
    }
}

// Routes
app.post('/api/auth/signup', (req, res) => {
    const { email, username, password } = req.body;
    const ip = req.clientIp;

    if (!email || !username || !password) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    bcrypt.hash(password, 10, (err, hashedPassword) => {
        if (err) return res.status(500).json({ error: 'Hash error' });

        db.run(
            'INSERT INTO users (email, username, password) VALUES (?, ?, ?)',
            [email, username, hashedPassword],
            function(err) {
                if (err) {
                    return res.status(400).json({ error: 'User already exists' });
                }

                // Track IP and device fingerprint
                if (ip) {
                    db.run('INSERT OR REPLACE INTO user_ips (user_id, ip_address, last_seen) VALUES (?, ?, datetime("now"))',
                        [this.lastID, ip]);
                }
                
                const fingerprint = generateDeviceFingerprint(req);
                db.run('INSERT OR IGNORE INTO device_fingerprints (user_id, fingerprint, user_agent, screen_res, timezone, language, last_seen) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))',
                    [this.lastID, fingerprint, req.headers['user-agent'], req.body?.screenRes, req.body?.timezone, req.body?.language]);

                const token = generateToken(this.lastID);
                res.json({ 
                    token, 
                    user: { id: this.lastID, email, username }
                });
            }
        );
    });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    const ip = req.clientIp;

    if (!email || !password) {
        return res.status(400).json({ error: 'Missing fields' });
    }

    db.get('SELECT * FROM users WHERE email = ? OR username = ?', [email, email], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }

        bcrypt.compare(password, user.password, (err, match) => {
            if (err || !match) {
                return res.status(401).json({ error: 'Invalid credentials' });
            }

            // Track IP and device fingerprint
            if (ip) {
                db.run('INSERT OR REPLACE INTO user_ips (user_id, ip_address, last_seen) VALUES (?, ?, datetime("now"))',
                    [user.id, ip]);
            }
            
            const fingerprint = generateDeviceFingerprint(req);
            db.run('INSERT OR IGNORE INTO device_fingerprints (user_id, fingerprint, user_agent, screen_res, timezone, language, last_seen) VALUES (?, ?, ?, ?, ?, ?, datetime("now"))',
                [user.id, fingerprint, req.headers['user-agent'], req.body?.screenRes, req.body?.timezone, req.body?.language]);

            const token = generateToken(user.id);
            res.json({ 
                token, 
                user: { id: user.id, email: user.email, username: user.username }
            });
        });
    });
});

app.post('/api/auth/verify', (req, res) => {
    const { token } = req.body;
    const decoded = verifyToken(token);

    if (!decoded) {
        return res.status(401).json({ error: 'Invalid token' });
    }

    db.get('SELECT id, email, username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user) {
            return res.status(401).json({ error: 'User not found' });
        }

        res.json({ user, token });
    });
});

app.get('/api/messages/:friendId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const { friendId } = req.params;

    db.all(
        `SELECT * FROM messages 
         WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
         ORDER BY created_at ASC`,
        [decoded.userId, friendId, friendId, decoded.userId],
        (err, messages) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            // Mark as read
            db.run(
                'UPDATE messages SET read = 1 WHERE receiver_id = ? AND sender_id = ?',
                [decoded.userId, friendId]
            );

            res.json(messages);
        }
    );
});

app.get('/api/friends', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    db.all(
        `SELECT u.id, u.username, u.email, 
                (SELECT COUNT(*) FROM messages WHERE sender_id = u.id AND receiver_id = ? AND read = 0) as unread_count
         FROM friendships f
         JOIN users u ON f.friend_id = u.id
         WHERE f.user_id = ?
         ORDER BY u.username`,
        [decoded.userId, decoded.userId],
        (err, friends) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(friends || []);
        }
    );
});

app.post('/api/friends/add', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    const { friendUsername } = req.body;

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT id FROM users WHERE username = ?', [friendUsername], (err, friend) => {
        if (err || !friend) {
            return res.status(404).json({ error: 'User not found' });
        }

        if (friend.id === decoded.userId) {
            return res.status(400).json({ error: 'Cannot add yourself' });
        }

        db.run(
            'INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)',
            [decoded.userId, friend.id],
            (err) => {
                if (err) return res.status(500).json({ error: 'Database error' });

                // Also add reverse friendship
                db.run(
                    'INSERT OR IGNORE INTO friendships (user_id, friend_id) VALUES (?, ?)',
                    [friend.id, decoded.userId]
                );

                res.json({ success: true, friend });
            }
        );
    });
});

// Admin endpoints
app.get('/api/admin/users', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.all(`SELECT u.id, u.username, u.email, 
                (SELECT ip_address FROM user_ips WHERE user_id = u.id ORDER BY last_seen DESC LIMIT 1) as latest_ip
                FROM users u ORDER BY username`, (err, users) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(users || []);
        });
    });
});

app.delete('/api/admin/users/:id', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        const { id } = req.params;

        if (parseInt(id) === decoded.userId) {
            return res.status(400).json({ error: 'Cannot delete yourself' });
        }

        db.run('DELETE FROM users WHERE id = ?', [id], function(err) {
            if (err) return res.status(500).json({ error: 'Delete failed' });
            db.run('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', [id, id]);
            db.run('DELETE FROM friendships WHERE user_id = ? OR friend_id = ?', [id, id]);
            res.json({ success: true });
        });
    });
});

// Update user credentials (admin)
app.put('/api/admin/users/:id', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        const { id } = req.params;
        const { username, email, password } = req.body;

        if (!username && !email && !password) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        if (parseInt(id) === decoded.userId) {
            return res.status(400).json({ error: 'Cannot edit yourself through this endpoint' });
        }

        // Check if new username/email already exists
        const checks = [];
        if (username) {
            checks.push(new Promise((resolve, reject) => {
                db.get('SELECT id FROM users WHERE username = ? AND id != ?', [username, id], (err, existing) => {
                    if (err) reject(err);
                    else if (existing) reject(new Error('Username already taken'));
                    else resolve();
                });
            }));
        }
        if (email) {
            checks.push(new Promise((resolve, reject) => {
                db.get('SELECT id FROM users WHERE email = ? AND id != ?', [email, id], (err, existing) => {
                    if (err) reject(err);
                    else if (existing) reject(new Error('Email already taken'));
                    else resolve();
                });
            }));
        }

        Promise.all(checks).then(() => {
            const updates = [];
            const values = [];

            if (username) {
                updates.push('username = ?');
                values.push(username);
            }
            if (email) {
                updates.push('email = ?');
                values.push(email);
            }

            if (password) {
                bcrypt.hash(password, 10, (err, hashedPassword) => {
                    if (err) return res.status(500).json({ error: 'Hash error' });
                    
                    updates.push('password = ?');
                    values.push(hashedPassword);
                    values.push(id);

                    const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
                    db.run(sql, values, function(err) {
                        if (err) return res.status(500).json({ error: 'Update failed' });
                        res.json({ success: true, changes: this.changes });
                    });
                });
            } else {
                values.push(id);
                const sql = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;
                db.run(sql, values, function(err) {
                    if (err) return res.status(500).json({ error: 'Update failed' });
                    res.json({ success: true, changes: this.changes });
                });
            }
        }).catch(err => {
            res.status(400).json({ error: err.message });
        });
    });
});

// Get system stats
app.get('/api/admin/stats', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        const stats = {};
        
        db.get('SELECT COUNT(*) as count FROM users', (err, result) => {
            stats.totalUsers = result ? result.count : 0;
            
            db.get('SELECT COUNT(*) as count FROM messages', (err, result) => {
                stats.totalMessages = result ? result.count : 0;
                
                db.get('SELECT COUNT(*) as count FROM friendships', (err, result) => {
                    stats.totalFriendships = result ? result.count / 2 : 0;
                    res.json(stats);
                });
            });
        });
    });
});

// Get all messages (admin)
app.get('/api/admin/messages', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.all(`
            SELECT m.*, 
                   u1.username as sender_name, 
                   u2.username as receiver_name
            FROM messages m
            JOIN users u1 ON m.sender_id = u1.id
            JOIN users u2 ON m.receiver_id = u2.id
            ORDER BY m.created_at DESC
            LIMIT 100
        `, (err, messages) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(messages || []);
        });
    });
});

// Delete user's messages
app.delete('/api/admin/messages/:userId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        const { userId } = req.params;
        db.run('DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', [userId, userId], function(err) {
            if (err) return res.status(500).json({ error: 'Delete failed' });
            res.json({ success: true, deleted: this.changes });
        });
    });
});

// Clear chat between two users
app.delete('/api/admin/chat/:user1/:user2', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        const { user1, user2 } = req.params;
        db.run(
            'DELETE FROM messages WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)',
            [user1, user2, user2, user1],
            function(err) {
                if (err) return res.status(500).json({ error: 'Delete failed' });
                res.json({ success: true, deleted: this.changes });
            }
        );
    });
});

// IP Ban Management Endpoints
app.get('/api/admin/ip-bans', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.all('SELECT * FROM ip_bans ORDER BY banned_at DESC', (err, bans) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(bans || []);
        });
    });
});

app.post('/api/admin/ip-bans', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    const { ip, reason } = req.body;

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        if (!ip) return res.status(400).json({ error: 'IP address required' });

        db.run(
            'INSERT INTO ip_bans (ip_address, reason, banned_by_user_id) VALUES (?, ?, ?)',
            [ip, reason || null, decoded.userId],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'IP already banned' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

app.delete('/api/admin/ip-bans/:ip', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    const { ip } = req.params;

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.run('DELETE FROM ip_bans WHERE ip_address = ?', [ip], function(err) {
            if (err) return res.status(500).json({ error: 'Delete failed' });
            res.json({ success: true, deleted: this.changes });
        });
    });
});

app.get('/api/admin/user-ips/:userId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    const { userId } = req.params;

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.all('SELECT ip_address, last_seen FROM user_ips WHERE user_id = ? ORDER BY last_seen DESC', [userId], (err, ips) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(ips || []);
        });
    });
});

// Hardware Ban Management Endpoints
app.get('/api/admin/hardware-bans', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.all('SELECT * FROM hardware_bans ORDER BY banned_at DESC', (err, bans) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(bans || []);
        });
    });
});

app.post('/api/admin/hardware-bans', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    const { fingerprint, reason } = req.body;

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        if (!fingerprint) return res.status(400).json({ error: 'Device fingerprint required' });

        db.run(
            'INSERT INTO hardware_bans (fingerprint, reason, banned_by_user_id) VALUES (?, ?, ?)',
            [fingerprint, reason || null, decoded.userId],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        return res.status(400).json({ error: 'Device already banned' });
                    }
                    return res.status(500).json({ error: 'Database error' });
                }
                res.json({ success: true, id: this.lastID });
            }
        );
    });
});

app.delete('/api/admin/hardware-bans/:fingerprint', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    const { fingerprint } = req.params;

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.run('DELETE FROM hardware_bans WHERE fingerprint = ?', [fingerprint], function(err) {
            if (err) return res.status(500).json({ error: 'Delete failed' });
            res.json({ success: true, deleted: this.changes });
        });
    });
});

app.get('/api/admin/user-devices/:userId', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    const { userId } = req.params;

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.all('SELECT fingerprint, user_agent, screen_res, timezone, language, last_seen FROM device_fingerprints WHERE user_id = ? ORDER BY last_seen DESC', [userId], (err, devices) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(devices || []);
        });
    });
});

// Track site visitor (anonymous)
app.post('/api/track-visitor', (req, res) => {
    const { fingerprint, userAgent, screenRes, timezone, language } = req.body;
    const ip = req.clientIp;
    
    db.run(
        'INSERT INTO site_visitors (ip_address, fingerprint, user_agent, screen_res, timezone, language, page_visited) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [ip, fingerprint || null, userAgent || null, screenRes || null, timezone || null, language || null, '/index.html'],
        function(err) {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json({ success: true, visitorId: this.lastID });
        }
    );
});

// Get all site visitors (admin only)
app.get('/api/admin/site-visitors', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        db.all(`SELECT * FROM site_visitors ORDER BY visited_at DESC LIMIT 1000`, (err, visitors) => {
            if (err) return res.status(500).json({ error: 'Database error' });
            res.json(visitors || []);
        });
    });
});

// Broadcast message to all users
app.post('/api/admin/broadcast', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);
    const { message } = req.body;

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        if (!message) return res.status(400).json({ error: 'Message required' });

        db.all('SELECT id FROM users WHERE id != ?', [decoded.userId], (err, users) => {
            if (err) return res.status(500).json({ error: 'Database error' });

            const timestamp = new Date().toISOString();
            let sent = 0;

            users.forEach(u => {
                db.run(
                    'INSERT INTO messages (sender_id, receiver_id, text) VALUES (?, ?, ?)',
                    [decoded.userId, u.id, `📢 ADMIN BROADCAST: ${message}`],
                    function(err) {
                        if (!err) {
                            sent++;
                            const recipientSocket = userSockets.get(u.id);
                            if (recipientSocket) {
                                io.to(recipientSocket).emit('receive_message', {
                                    id: this.lastID,
                                    sender_id: decoded.userId,
                                    receiver_id: u.id,
                                    text: `📢 ADMIN BROADCAST: ${message}`,
                                    read: false,
                                    created_at: timestamp
                                });
                            }
                        }
                    }
                );
            });

            res.json({ success: true, sent: users.length });
        });
    });
});

// Get user details with stats
app.get('/api/admin/user/:id', (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    const decoded = verifyToken(token);

    if (!decoded) return res.status(401).json({ error: 'Unauthorized' });

    db.get('SELECT username FROM users WHERE id = ?', [decoded.userId], (err, user) => {
        if (err || !user || user.username !== 'coopsiguess') {
            return res.status(403).json({ error: 'Admin only' });
        }

        const { id } = req.params;
        const userStats = {};

        db.get('SELECT id, username, email, created_at FROM users WHERE id = ?', [id], (err, userData) => {
            if (err || !userData) return res.status(404).json({ error: 'User not found' });
            
            userStats.user = userData;

            db.get('SELECT COUNT(*) as count FROM messages WHERE sender_id = ?', [id], (err, result) => {
                userStats.messagesSent = result ? result.count : 0;

                db.get('SELECT COUNT(*) as count FROM messages WHERE receiver_id = ?', [id], (err, result) => {
                    userStats.messagesReceived = result ? result.count : 0;

                    db.get('SELECT COUNT(*) as count FROM friendships WHERE user_id = ?', [id], (err, result) => {
                        userStats.friendCount = result ? result.count : 0;

                        res.json(userStats);
                    });
                });
            });
        });
    });
});

// Socket.io for real-time features
const userSockets = new Map();
const typingUsers = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('auth', (token) => {
        const decoded = verifyToken(token);
        if (decoded) {
            userSockets.set(decoded.userId, socket.id);
            socket.userId = decoded.userId;
        }
    });

    socket.on('send_message', (data) => {
        const { receiverId, text, image } = data;
        const senderId = socket.userId;

        console.log(`Message from ${senderId} to ${receiverId}:`, { text: text?.substring(0, 50), hasImage: !!image });

        if (!senderId || !receiverId) {
            console.error('Missing senderId or receiverId', { senderId, receiverId });
            return;
        }

        const timestamp = new Date().toISOString();

        // Save to database
        db.run(
            'INSERT INTO messages (sender_id, receiver_id, text, image) VALUES (?, ?, ?, ?)',
            [senderId, receiverId, text || null, image || null],
            function(err) {
                if (err) {
                    console.error('Database error saving message:', err);
                    return;
                }

                console.log('Message saved to DB with ID:', this.lastID);

                const messageData = {
                    id: this.lastID,
                    sender_id: senderId,
                    receiver_id: receiverId,
                    text: text || null,
                    image: image || null,
                    read: false,
                    created_at: timestamp
                };

                // Send to recipient
                const recipientSocket = userSockets.get(receiverId);
                console.log(`Recipient socket for ${receiverId}:`, recipientSocket ? 'found' : 'not found');
                if (recipientSocket) {
                    io.to(recipientSocket).emit('receive_message', messageData);
                }

                // Confirm to sender
                socket.emit('message_sent', messageData);
            }
        );
    });

    socket.on('typing', (data) => {
        const { receiverId } = data;
        const senderId = socket.userId;

        typingUsers.set(senderId, receiverId);

        const recipientSocket = userSockets.get(receiverId);
        if (recipientSocket) {
            io.to(recipientSocket).emit('user_typing', { userId: senderId });
        }
    });

    socket.on('stop_typing', (data) => {
        const { receiverId } = data;
        const senderId = socket.userId;

        typingUsers.delete(senderId);

        const recipientSocket = userSockets.get(receiverId);
        if (recipientSocket) {
            io.to(recipientSocket).emit('user_stop_typing', { userId: senderId });
        }
    });

    socket.on('mark_as_read', (data) => {
        const { senderId } = data;
        const receiverId = socket.userId;

        db.run(
            'UPDATE messages SET read = 1 WHERE sender_id = ? AND receiver_id = ?',
            [senderId, receiverId]
        );

        const senderSocket = userSockets.get(senderId);
        if (senderSocket) {
            io.to(senderSocket).emit('message_read', { userId: receiverId });
        }
    });

    socket.on('snap_opened', (data) => {
        const { messageId, senderId } = data;
        const openedBy = socket.userId;

        db.run(
            'UPDATE messages SET opened_at = CURRENT_TIMESTAMP WHERE id = ?',
            [messageId]
        );

        const senderSocket = userSockets.get(senderId);
        if (senderSocket) {
            io.to(senderSocket).emit('snap_viewed', { messageId, openedBy });
        }
    });

    socket.on('disconnect', () => {
        if (socket.userId) {
            userSockets.delete(socket.userId);
            typingUsers.delete(socket.userId);
        }
        console.log('User disconnected:', socket.id);
    });
});

server.listen(PORT, () => {
    console.log(`MESnap server running on http://localhost:${PORT}`);
});
