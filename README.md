# Queue System

A live queue system built for NASA International Schools. `control.html` is the control panel for stations and queues, and `display.html` is the public screen. The two pages stay in step through the browser's BroadcastChannel API, so there is no backend despite the repo name. Live demo: [queue.amrhammoud.com](https://queue.amrhammoud.com).

## Deploy

```bash
npx wrangler deploy
```

## Stack

- HTML, CSS and JavaScript
- Cloudflare Workers static assets

## License

[MIT](LICENSE)
