const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

// Connect to database
const db = new sqlite3.Database('./mesnap.db', (err) => {
    if (err) {
        console.error('Database connection error:', err);
        process.exit(1);
    }
    console.log('Connected to SQLite database');
});

// Test users to create
const testUsers = [
    { email: 'test@example.com', username: 'testuser', password: 'password123' },
    { email: 'demo@example.com', username: 'demouser', password: 'demo123' },
    { email: 'alice@example.com', username: 'alice', password: 'alice123' },
    { email: 'bob@example.com', username: 'bob', password: 'bob123' }
];

// Function to create a user
function createUser(userData) {
    bcrypt.hash(userData.password, 10, (err, hashedPassword) => {
        if (err) {
            console.error('Hash error:', err);
            return;
        }

        db.run(
            'INSERT INTO users (email, username, password) VALUES (?, ?, ?)',
            [userData.email, userData.username, hashedPassword],
            function(err) {
                if (err) {
                    if (err.message.includes('UNIQUE')) {
                        console.log(`⚠️  User already exists: ${userData.username} (${userData.email})`);
                    } else {
                        console.error(`Error creating user ${userData.username}:`, err.message);
                    }
                } else {
                    console.log(`✅ Created test user: ${userData.username}`);
                    console.log(`   Email: ${userData.email}`);
                    console.log(`   Password: ${userData.password}`);
                    console.log('');
                }
            }
        );
    });
}

// Create all test users
console.log('Creating test users...\n');
testUsers.forEach(user => createUser(user));

// Close database connection after a short delay
setTimeout(() => {
    db.close((err) => {
        if (err) {
            console.error('Database close error:', err);
        } else {
            console.log('Database connection closed');
            process.exit(0);
        }
    });
}, 1500);
