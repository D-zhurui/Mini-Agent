// Wordle 中文版 - 核心游戏逻辑

// 中文5字词语词库（精选常用词）
const WORD_LIST = [
    '苹果手机', '微信支付', '支付宝', '美团外卖', '滴滴打车',
    '今日头条', '抖音视频', '快手直播', '小红书', '哔哩哔哩',
    '华为手机', '小米手机', 'OPPO手机', 'VIVO手机', '三星手机',
    '腾讯会议', '钉钉办公', '飞书协作', '企业微信', 'WPS办公',
    '百度搜索', '谷歌搜索', '必应搜索', '搜狗搜索', '360搜索',
    '京东购物', '淘宝购物', '拼多多', '唯品会', '苏宁易购',
    '网易邮箱', 'QQ邮箱', '163邮箱', 'Gmail邮箱', 'Outlook邮箱',
    '中国银行', '工商银行', '建设银行', '农业银行', '交通银行',
    '北京大学', '清华大学', '复旦大学', '上海交大', '浙江大学',
    '人民日报', '新华社', '央视新闻', '光明日报', '经济日报'
];

// 随机选择目标词
function getRandomWord() {
    const randomIndex = Math.floor(Math.random() * WORD_LIST.length);
    return WORD_LIST[randomIndex];
}

// 检查猜测结果
function checkGuess(guess, target) {
    const result = [];
    
    // 先标记所有正确位置的字母
    for (let i = 0; i < guess.length; i++) {
        if (guess[i] === target[i]) {
            result[i] = 'correct';
        } else {
            result[i] = 'absent';
        }
    }
    
    // 再标记位置错误但存在的字母
    const targetLetters = {};
    for (let i = 0; i < target.length; i++) {
        if (!result[i] === 'correct') {
            targetLetters[target[i]] = (targetLetters[target[i]] || 0) + 1;
        }
    }
    
    for (let i = 0; i < guess.length; i++) {
        if (result[i] === 'correct') continue;
        
        if (targetLetters[guess[i]] > 0) {
            result[i] = 'present';
            targetLetters[guess[i]]--;
        }
    }
    
    return result;
}

// 游戏状态管理
class WordleGame {
    constructor() {
        this.targetWord = getRandomWord();
        this.currentRow = 0;
        this.currentCol = 0;
        this.gameOver = false;
        this.maxAttempts = 6;
        
        this.init();
    }
    
    init() {
        this.setupEventListeners();
        this.showMessage('欢迎来到 Wordle 中文版！输入5个字，按 Enter 提交');
    }
    
    setupEventListeners() {
        // 键盘事件
        document.addEventListener('keydown', (e) => this.handleKeyPress(e));
        
        // 键盘点击事件
        const keyboard = document.getElementById('keyboard');
        if (keyboard) {
            keyboard.addEventListener('click', (e) => this.handleKeyboardClick(e));
        }
    }
    
    handleKeyPress(e) {
        if (this.gameOver) return;
        
        const key = e.key;
        
        if (/^[\u4e00-\u9fa5]$/.test(key)) { // 中文字符
            if (this.currentCol < 5) {
                this.setCell(this.currentRow, this.currentCol, key);
                this.currentCol++;
            }
        } else if (e.key === 'Enter') {
            this.submitGuess();
        } else if (e.key === 'Backspace') {
            if (this.currentCol > 0) {
                this.currentCol--;
                this.setCell(this.currentRow, this.currentCol, '');
            }
        }
    }
    
    handleKeyboardClick(e) {
        const keyEl = e.target.closest('.key');
        if (!keyEl || !keyEl.dataset.key) return;
        
        const key = keyEl.dataset.key;
        
        if (key === 'ENTER') {
            this.submitGuess();
        } else if (key === 'BACKSPACE') {
            if (this.currentCol > 0) {
                this.currentCol--;
                this.setCell(this.currentRow, this.currentCol, '');
            }
        } else {
            if (this.currentCol < 5 && /[^\s]/.test(key)) {
                this.setCell(this.currentRow, this.currentCol, key);
                this.currentCol++;
            }
        }
    }
    
    setCell(row, col, value) {
        const cell = document.querySelector(`[data-row="${row}"][data-col="${col}"]`);
        if (cell) {
            cell.textContent = value;
        }
    }
    
    submitGuess() {
        if (this.currentCol !== 5) return;
        
        // 获取当前行的猜测
        let guess = '';
        for (let i = 0; i < 5; i++) {
            const cell = document.querySelector(`[data-row="${this.currentRow}"][data-col="${i}"]`);
            guess += cell ? cell.textContent : '';
        }
        
        // 验证输入
        if (guess.length !== 5) {
            this.showMessage('请输入5个字！');
            return;
        }
        
        // 检查结果
        const result = checkGuess(guess, this.targetWord);
        
        // 更新格子样式
        for (let i = 0; i < 5; i++) {
            const cell = document.querySelector(`[data-row="${this.currentRow}"][data-col="${i}"]`);
            if (cell) {
                cell.className = `cell ${result[i]}`;
            }
        }
        
        // 检查游戏状态
        if (guess === this.targetWord) {
            this.showMessage(`🎉 恭喜！你猜对了！答案是：${this.targetWord}`);
            this.gameOver = true;
        } else if (this.currentRow === this.maxAttempts - 1) {
            this.showMessage(`很遗憾，正确答案是：${this.targetWord}`);
            this.gameOver = true;
        } else {
            this.currentRow++;
            this.currentCol = 0;
        }
    }
    
    showMessage(text) {
        const messageEl = document.getElementById('message');
        if (messageEl) {
            messageEl.textContent = text;
            setTimeout(() => {
                if (messageEl.textContent === text) {
                    messageEl.textContent = '';
                }
            }, 3000);
        }
    }
}

// 初始化游戏
document.addEventListener('DOMContentLoaded', () => {
    new WordleGame();
});