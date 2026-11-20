const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve the website from any working directory

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/bookhive', {
    useNewUrlParser: true,
    useUnifiedTopology: true
})
.then(() => console.log('MongoDB Connected'))
.catch(err => console.log('MongoDB Error:', err));

// User Schema
const userSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
        trim: true
    },
    email: {
        type: String,
        required: true,
        unique: true,
        lowercase: true,
        trim: true
    },
    password: {
        type: String,
        required: true,
        minlength: 8
    },
    userId: {
        type: String,
        unique: true
    },
    userType: {
        type: String,
        default: 'Student',
        enum: ['Student', 'Graduate Student', 'Faculty', 'Staff']
    },
    status: {
        type: String,
        default: 'Active',
        enum: ['Active', 'Inactive', 'Suspended']
    },
    borrowedBooks: [{
        bookId: Number,
        title: String,
        author: String,
        dueDate: Date,
        borrowedDate: {
            type: Date,
            default: Date.now
        }
    }],
    reservations: [{
        bookId: Number,
        title: String,
        author: String,
        status: String,
        expiryDate: Date
    }],
    borrowingHistory: [{
        bookId: Number,
        title: String,
        author: String,
        borrowedDate: Date,
        returnedDate: Date
    }],
    fines: {
        type: Number,
        default: 0
    },
    settings: {
        emailNotifications: {
            type: Boolean,
            default: true
        },
        smsReminders: {
            type: Boolean,
            default: false
        },
        autoRenew: {
            type: Boolean,
            default: true
        }
    },
    createdAt: {
        type: Date,
        default: Date.now
    }
});

// Hash password before saving
userSchema.pre('save', async function(next) {
    if (!this.isModified('password')) return next();
    
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt);
        
        // Generate userId if not exists
        if (!this.userId) {
            const prefix = this.userType === 'Graduate Student' ? 'GS' : 'ST';
            const year = new Date().getFullYear();
            const random = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
            this.userId = `${prefix}${year}-${random}`;
        }
        
        next();
    } catch (error) {
        next(error);
    }
});

const User = mongoose.model('User', userSchema);

// Auth Middleware
const auth = async (req, res, next) => {
    try {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            throw new Error();
        }
        
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key-change-this');
        const user = await User.findById(decoded.id).select('-password');
        
        if (!user) {
            throw new Error();
        }
        
        req.user = user;
        req.token = token;
        next();
    } catch (error) {
        res.status(401).json({ message: 'Please authenticate' });
    }
};

// Routes

// Signup Route
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password, userType } = req.body;
        
        // Check if user already exists
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).json({ message: 'Email already registered' });
        }
        
        // Create new user
        const user = new User({
            name,
            email,
            password,
            userType: userType || 'Student'
        });
        
        await user.save();
        
        // Generate token
        const token = jwt.sign(
            { id: user._id },
            process.env.JWT_SECRET || 'your-secret-key-change-this',
            { expiresIn: '7d' }
        );
        
        res.status(201).json({
            message: 'User created successfully',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                userId: user.userId,
                userType: user.userType
            }
        });
    } catch (error) {
        console.error('Signup error:', error);
        res.status(500).json({ message: 'Error creating user', error: error.message });
    }
});

// Login Route
app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        // Find user
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        
        // Check password
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({ message: 'Invalid email or password' });
        }
        
        // Generate token
        const token = jwt.sign(
            { id: user._id },
            process.env.JWT_SECRET || 'your-secret-key-change-this',
            { expiresIn: '7d' }
        );
        
        res.json({
            message: 'Login successful',
            token,
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                userId: user.userId,
                userType: user.userType,
                status: user.status
            }
        });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ message: 'Error logging in', error: error.message });
    }
});

// Get User Profile
app.get('/api/user/profile', auth, async (req, res) => {
    try {
        const user = await User.findById(req.user._id).select('-password');
        
        // Calculate stats
        const stats = {
            booksCheckedOut: user.borrowedBooks.length,
            itemsReserved: user.reservations.length,
            overdueItems: user.borrowedBooks.filter(book => 
                new Date(book.dueDate) < new Date()
            ).length,
            finesOutstanding: user.fines,
            borrowingLimit: user.userType === 'Graduate Student' ? 25 : 15
        };
        
        res.json({
            user: {
                name: user.name,
                email: user.email,
                userId: user.userId,
                userType: user.userType,
                status: user.status,
                borrowedBooks: user.borrowedBooks,
                reservations: user.reservations,
                borrowingHistory: user.borrowingHistory.slice(-10), // Last 10
                settings: user.settings
            },
            stats
        });
    } catch (error) {
        console.error('Profile error:', error);
        res.status(500).json({ message: 'Error fetching profile' });
    }
});

// Update User Settings
app.patch('/api/user/settings', auth, async (req, res) => {
    try {
        const { emailNotifications, smsReminders, autoRenew } = req.body;
        
        const user = await User.findById(req.user._id);
        
        if (emailNotifications !== undefined) {
            user.settings.emailNotifications = emailNotifications;
        }
        if (smsReminders !== undefined) {
            user.settings.smsReminders = smsReminders;
        }
        if (autoRenew !== undefined) {
            user.settings.autoRenew = autoRenew;
        }
        
        await user.save();
        
        res.json({ message: 'Settings updated successfully', settings: user.settings });
    } catch (error) {
        console.error('Settings error:', error);
        res.status(500).json({ message: 'Error updating settings' });
    }
});

// Borrow Book
app.post('/api/user/borrow', auth, async (req, res) => {
    try {
        const { bookId, title, author } = req.body;
        
        const user = await User.findById(req.user._id);
        
        // Check borrowing limit
        const limit = user.userType === 'Graduate Student' ? 25 : 15;
        if (user.borrowedBooks.length >= limit) {
            return res.status(400).json({ message: 'Borrowing limit reached' });
        }
        
        // Add to borrowed books (default 14 days loan period)
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 14);
        
        user.borrowedBooks.push({
            bookId,
            title,
            author,
            dueDate
        });
        
        await user.save();
        
        res.json({ message: 'Book borrowed successfully', borrowedBooks: user.borrowedBooks });
    } catch (error) {
        console.error('Borrow error:', error);
        res.status(500).json({ message: 'Error borrowing book' });
    }
});

// Return Book
app.post('/api/user/return', auth, async (req, res) => {
    try {
        const { bookId } = req.body;
        
        const user = await User.findById(req.user._id);
        
        // Find and remove from borrowed books
        const bookIndex = user.borrowedBooks.findIndex(b => b.bookId === bookId);
        
        if (bookIndex === -1) {
            return res.status(404).json({ message: 'Book not found in borrowed list' });
        }
        
        const book = user.borrowedBooks[bookIndex];
        
        // Add to history
        user.borrowingHistory.push({
            bookId: book.bookId,
            title: book.title,
            author: book.author,
            borrowedDate: book.borrowedDate,
            returnedDate: new Date()
        });
        
        // Remove from borrowed
        user.borrowedBooks.splice(bookIndex, 1);
        
        await user.save();
        
        res.json({ message: 'Book returned successfully' });
    } catch (error) {
        console.error('Return error:', error);
        res.status(500).json({ message: 'Error returning book' });
    }
});

// Logout Route (client-side will clear token)
app.post('/api/auth/logout', auth, (req, res) => {
    res.json({ message: 'Logged out successfully' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});