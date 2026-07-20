# Deploying Appointment Secretary to a VPS (Ubuntu)

Result: the app runs 24/7 at `https://your-domain`, usable from anywhere, phones install it
as a mobile app with no warnings.

## What you need
- A VPS (Ubuntu 20.04+ recommended) with SSH access
- A domain or subdomain pointed to the VPS IP (an `A` record, e.g. `book.yourdomain.com`).
  A free DuckDNS subdomain also works.

## 1. Install Node.js and pm2 (on the VPS)

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pm2
```

## 2. Copy the app to the VPS

From the Windows PC (PowerShell), copy the whole folder **including `data/`**
(it carries the users, settings, Gmail password and Google key):

```powershell
scp -r "C:\Users\Admin\Desktop\RRE SEC" user@VPS_IP:/home/user/secretary
```

## 3. Start it with pm2

```bash
cd /home/user/secretary
npm install
pm2 start server.js --name secretary
pm2 save
pm2 startup   # run the command it prints — auto-start after reboot
```

## 4. HTTPS with Caddy (automatic certificate)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

Then edit `/etc/caddy/Caddyfile` to exactly:

```
book.yourdomain.com {
    reverse_proxy localhost:3010
}
```

```bash
sudo systemctl reload caddy
```

Caddy fetches and renews a free HTTPS certificate automatically. Open ports 80 + 443 in the
VPS firewall (`sudo ufw allow 80,443/tcp`).

## 5. After it works

- Everyone opens `https://book.yourdomain.com`, logs in with the SAME accounts as before,
  and reinstalls the home-screen app from the new address.
- **Stop the app on the Windows PC** (close the window / don't run the .bat) — if both run,
  customers get reminders twice.
- The `data/` folder now lives on the VPS — back it up from there.
- The self-signed cert (`data/cert.pfx`) is ignored on the VPS if you delete it there;
  Caddy handles HTTPS. Deleting it is recommended so only port 3010 (behind Caddy) serves.
