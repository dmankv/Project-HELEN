# HELEN CLI - Text-Based Interface

## Overview

HELEN now includes a full-featured text-based Command Line Interface (CLI) for terminal-based interaction. This is perfect for:
- Terminal/console-based workflows
- Server-side interactions
- Scripting and automation
- Lightweight environments
- Local development and testing

## 🚀 Quick Start

### Option 1: Using npm
```bash
cd somthing
npm install
npm run cli
```

### Option 2: Using the shell script (Linux/Mac)
```bash
cd somthing
chmod +x bin/helen.sh
./bin/helen.sh
```

### Option 3: Using Python wrapper
```bash
cd somthing
python3 bin/helen-cli.py
```

### Option 4: Direct TypeScript execution
```bash
cd somthing
impx ts-node src/cli/helen-cli.ts
```

## 💬 Interactive Features

The HELEN CLI provides a dark-themed terminal interface where you can:
- **Chat freely** - Type any message and press Enter
- **Get instant responses** - HELEN processes with its learning pipeline
- **View processing details** - See intent, confidence, and memory usage
- **Rate responses** - Provide feedback to improve HELEN
- **Check statistics** - View conversation and learning statistics
- **Export data** - Save all learning data for analysis

## 📝 Available Commands

### General Commands
- **`help`** - Display available commands
- **`exit`** or **`quit`** - Exit HELEN
- **`clear`** - Clear the terminal screen

### Analytics Commands
- **`stats`** - Show conversation statistics
- **`memory`** - Display memory and learning statistics
- **`feedback`** - Rate the last HELEN response
- **`export`** - Export all learning data as JSON

## 🎨 Dark Theme Features

The CLI features a beautiful dark theme with:
- **Color-coded output**
  - Cyan for HELEN's responses
  - White for your messages
  - Green for positive feedback
  - Yellow for warnings
  - Magenta for statistics
- **Visual separators** - Clear boundaries between messages
- **Status indicators** - Shows HELEN's thinking process
- **Readable formatting** - Easy-to-scan message layout

## 📊 Response Metadata

Each HELEN response includes processing details:
- **Intent** - What HELEN understood you to be asking
- **Confidence** - How confident HELEN is in the response (0-100%)
- **Ambiguity Level** - How unclear the input was (0-100%)
- **Memory Items Used** - How many past interactions were referenced

## 💾 Learning & Feedback

### Providing Feedback
1. After each response, HELEN prompts you to provide feedback
2. Type **`feedback`** to rate the last response
3. Choose:
   - **[1]** 👍 Helpful
   - **[2]** ➖ Neutral
   - **[3]** 👎 Unhelpful
4. Optionally add a comment
5. HELEN learns and improves for future interactions

### Learning Process
Feedback is processed through HELEN's learning pipeline:
1. Feedback is recorded
2. Policies are updated
3. Success metrics are calculated
4. Memory is indexed for future retrieval

## 📈 Statistics & Analytics

### Session Statistics (`stats` command)
- Messages processed
- Session duration
- Start time

### Learning Statistics (`memory` command)
- Memory store contents
- Total interactions
- Success rate
- Average confidence
- Learning cycles completed
- Intent distribution

## 📤 Exporting Data

Export all learning data:
```
Command: export
Output: JSON file with all interactions, feedback, and statistics
```

Data includes:
- Complete conversation history
- Learning records
- Feedback logs
- Agent statistics
- Policy versions

## 🎯 Example Conversation

```
╔═════════════════════════════════════════════════════════════════════════════╗
║                                                                             ║
║                  🤖  HELEN - Adaptive AI Assistant  🤖                    ║
║                                                                             ║
║              Your smart, learning AI with memory and planning              ║
║                                                                             ║
╚═════════════════════════════════════════════════════════════════════════════╝

  Type your message and press Enter. Type "help" for commands.

> What is machine learning?

  YOU:
  "What is machine learning?"

  [HELEN is thinking...]

  HELEN:
  Machine learning is a subset of artificial intelligence that enables systems
  to learn and improve from experience without being explicitly programmed...

  [Processing Details]
  • Intent: request-explanation
  • Confidence: 85%
  • Ambiguity Level: 15%
  • Memory Items Used: 2

  [Type "feedback" to rate this response]

> feedback

  RATE THE LAST RESPONSE:
  [1] 👍 Helpful
  [2] ➖ Neutral
  [3] 👎 Unhelpful
  Your choice (1-3): 1
  Add a comment (optional, press Enter to skip): Great explanation!

  ✓ Feedback recorded! HELEN learns from this.
```

## ⌨️ Keyboard Shortcuts

- **Enter** - Send message
- **Ctrl+C** - Exit HELEN
- **Ctrl+L** or **clear** - Clear screen

## 🔧 Troubleshooting

### "Node.js not found"
- Install Node.js 18 or higher from nodejs.org

### "Command not found: ts-node"
- Run `npm install` first

### "Permission denied" (on ./bin/helen.sh)
- Run: `chmod +x bin/helen.sh`

### Slow response time
- First response may be slower as HELEN initializes
- Subsequent responses should be faster (~100ms)

## 📝 Configuration

Modify `src/cli/helen-cli.ts` to customize:
- Color scheme
- Prompt text
- Separator characters
- Response formatting
- Command keywords

## 🌐 Integration with Web Interface

The CLI and web interface share:
- Same HELEN core engine
- Same learning algorithm
- Same memory store
- Same feedback system
- Same policy updates

You can:
1. Use CLI for rapid testing
2. Switch to web interface for visualization
3. Export data from either interface
4. Both interfaces learn from each other's feedback

## 🚀 Advanced Usage

### Running HELEN in a Docker container
```bash
docker run -it helen-cli
```

### Piping input to HELEN
```bash
echo "What is AI?" | npx ts-node src/cli/helen-cli.ts
```

### Running HELEN as a background service
```bash
screen -S helen npx ts-node src/cli/helen-cli.ts
```

## 📚 Documentation

For more information:
- Full guide: `HELEN_ACCESS_GUIDE.md`
- Architecture: `DEPLOYMENT.md`
- Source code: `src/cli/helen-cli.ts`

---

**Happy chatting with HELEN! 🤖**
