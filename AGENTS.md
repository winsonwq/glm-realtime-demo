# AGENTS.md

## Git Commit Rules

When making commits, follow these rules:

1. **Commit message must be in English**
2. **No detailed description needed** - use concise commit messages
3. **After committing, record the commit in this file**

### Commit Format

```bash
git add <files>
git commit -m "Brief description in English"
git push
```

### Example

```bash
git add index.html proxy-server.js
git commit -m "Add system message settings UI and MCP tools integration"
git push
```

## Doubao Realtime Voice Model

### Reference Documentation
- Realtime API: https://www.volcengine.com/docs/6893/1527770
- WebSocket Protocol: https://www.volcengine.com/docs/6561/1329505
- Full API Docs: https://www.volcengine.com/docs/6561/1594356

### Running Commands

```bash
# Start Doubao proxy server
npm run doubao

# Access Doubao frontend
# Open: http://localhost:3001/doubao-index.html

# Or start with nodemon for development
npm run doubao:dev
```

### Recent Commits
- Add Doubao realtime voice API support with WebSocket proxy server