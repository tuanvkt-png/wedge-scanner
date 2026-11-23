# WEDGE SCANNER — Phân tích Kỹ thuật Tự động

Ứng dụng web phân tích **mẫu hình Wedge** (High/Low · breakdown/breakout · Entry/SL/TP),
giao diện giống trang *Phân tích Kỹ thuật Tự động — Setup Lệnh*.

## Chạy giống trang tham chiếu

- **Render (có backend `/api/scan`)** — Flask + Yahoo server-side → không lo CORS.
- **GitHub Pages (static)** — fallback phân tích ngay trên trình duyệt nếu không có API.

## Chạy local

```bash
cd wedge-scanner
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python app.py
# http://localhost:8080
```

## Deploy lên Render

1. Push repo lên GitHub (xem bên dưới).
2. Vào [render.com](https://render.com) → **New → Blueprint** (hoặc **New → Web Service**).
3. Chọn repo GitHub vừa tạo.
4. Render đọc tự động `render.yaml`:
   - Build: `pip install -r requirements.txt`
   - Start: `gunicorn -w 2 -b 0.0.0.0:$PORT app:app`
5. Deploy xong → URL `https://wedge-scanner-xxxx.onrender.com`.

> Lần đầu free service Render có thể sleep — bấm mở 1 lần là “đánh thức”.

## Deploy GitHub Pages (static, không API)

1. Repo → **Settings → Pages → Deploy from a branch** → `main` / root.
2. Trang vẫn chạy được ở chế độ **client-side** (tự detect không có `/api` thì phân tích lokal).

## Push lên GitHub (từ máy bạn)

```bash
cd wedge-scanner
git add -A
git commit -m "Wedge scanner: Flask API + UI giống trang tham chiếu"
git branch -M main
git remote add origin https://github.com/<tai-khoan>/wedge-scanner.git
git push -u origin main
```

Nếu chưa có GitHub CLI:

```bash
# tạo repo trên github.com/new trước, rồi:
git remote add origin https://github.com/<tai-khoan>/wedge-scanner.git
git push -u origin main
```

## API (giống trang tham chiếu)

| Endpoint | Mô tả |
|---|---|
| `GET /api/symbols` | Danh mục mã |
| `GET /api/settings` · `POST /api/settings` | Cài đặt + watchlist |
| `GET /api/scan?symbol=GC=F&interval=1h` | Phân tích 1 mã |
| `GET /api/scan-all?interval=4h` | Quét tất cả |
| `GET /api/watchlist-scan?interval=1h&only_beautiful=true` | Setup đẹp |

## Chiến lược Wedge

1. Nến Yahoo Finance (15m/30m/1h/4h/1d/1wk).
2. ZigZag + fractal → swing.
3. Fit 2 đường biên **hội tụ** → Wedge.
4. Đánh dấu **HIGH / LOW**.
5. **Breakdown/Breakout** → retest → Entry / SL / TP (R:R 1:2).
6. Checklist 6 điều kiện + grade A+…E + Kijun H4.

## Cấu trúc

```
wedge-scanner/
├── app.py                 # Flask API + phân tích server-side
├── requirements.txt
├── render.yaml            # Render Blueprint
├── Procfile
├── index.html             # UI
├── static/css/style.css
├── static/js/
│   ├── lightweight-charts.standalone.production.js
│   ├── indicators.js · data.js · wedge.js   # fallback client
│   └── app.js                                 # gọi /api/* hoặc fallback
└── README.md
```

⚠️ **Không phải lời khuyên đầu tư.**
