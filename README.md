# Appointment Secretary

A web app for your team: multiple users log in, book customer appointments, and the app
automatically sends reminders by **Email** (working now), **WhatsApp** and **SMS** (switch on
when you have the accounts — see below).

## How to start

Double-click **`Start Secretary App.bat`**, then open **http://localhost:3010** in your browser.
Keep the black window open — reminders are sent while it runs.

- The **first account** you register becomes the **admin**.
- Other staff open the same link and register their own accounts.
- From phones/PCs on the **same Wi-Fi**, use this computer's IP address, e.g. `http://192.168.1.5:3010`
  (find it with `ipconfig` → "IPv4 Address"). Windows Firewall may ask once — click Allow.

## Use it as a mobile app

The app is installable (PWA). On a phone connected to the **same Wi-Fi** as this PC:

1. Open `http://192.168.0.15:3010` in the phone browser (this PC's current IP).
2. **Android (Chrome):** menu ⋮ → **Add to Home screen** / **Install app**.
   **iPhone (Safari):** Share button → **Add to Home Screen**.
3. A "Secretary" icon appears on the phone — it opens full-screen like a normal app.

The firewall rule for port 3010 is already added. If the PC's IP changes, check it again with
`ipconfig`. For using the app from **anywhere** (not just office Wi-Fi), the app must move to
cloud hosting — ask Claude when ready.

## Location on appointments (📍 Use my current location)

The appointment form can capture GPS coordinates and shows a Google Maps link on the dashboard
and in the customer's reminder message. Browsers only allow location on a **secure address**:

- On this PC: `http://localhost:3010` works as-is.
- On phones: use **`https://192.168.0.15:3443`** (note the **https** and port **3443**).
  The first time, the browser shows a "connection not private" warning because the app uses a
  self-made certificate — tap **Advanced → Proceed**. That's expected and safe on your own Wi-Fi.
  Install the home-screen app from this https address to have location working inside it.
- The certificate covers IP 192.168.0.15. If the PC's IP changes, ask Claude to regenerate it
  (`data/cert.pfx`).

## Set up email reminders (free, ~5 minutes)

1. Log in as admin → **Settings** → Email (SMTP) section.
2. Use a Gmail account. In Google: **Account → Security → 2-Step Verification → App passwords**
   → create one for "Mail" and copy the 16-character password.
3. In Settings enter the Gmail address and that App Password, save, then click **Send test email**.

## Switch on WhatsApp later

Option A — **Meta WhatsApp Cloud API** (cheapest):
1. Create a Facebook Business account at business.facebook.com, then an app at developers.facebook.com
   with the WhatsApp product.
2. Add a phone number that is **not** already used on normal WhatsApp.
3. Copy the **Phone Number ID** and a permanent **Access Token** into Settings and set provider to *Meta*.
4. Important rule: WhatsApp only delivers free-text messages to customers who messaged you in the
   last 24 hours. For reminder messages to anyone, you must create an approved **message template**
   in Meta Business Manager. Ask Claude to wire the template in when you reach this step.

Option B — **Twilio**: create an account at twilio.com, enable the WhatsApp sender, and fill the
Twilio section in Settings.

## Switch on SMS later

- **India**: register your business on a DLT portal (e.g. Jio/Airtel/Vodafone DLT), get your
  reminder message template approved, then create an MSG91 account and fill Auth key, Sender ID
  and Template ID in Settings. The DLT template text must match the app's message template.
- **International / fastest**: Twilio — buy a number and fill the Twilio section in Settings.

## Google Sheet sync

The app keeps a Google Sheet up to date automatically (Sheet ID is set in Settings):

- **Users** tab — every user with email, role, time zone, join date and appointment count
- **All appointments** tab — the complete list
- **One tab per user** (e.g. "Priya #2") — created automatically when a new user registers,
  carrying all of that user's appointments

To activate it:

1. Go to **console.cloud.google.com** → IAM & Admin → **Service Accounts** → open your
   account (`rre-sec@rre-sec.iam.gserviceaccount.com`).
2. **Keys** tab → **Add key → Create new key → JSON** → a file downloads.
3. Save that file as **`data\google-key.json`** inside this app folder (rename it exactly).
4. Open your Google Sheet → **Share** → add `rre-sec@rre-sec.iam.gserviceaccount.com`
   as **Editor**.
5. In the app: Settings → **Sync all appointments to the Sheet** to test.

After that, every add/edit/cancel updates the Sheet automatically. Keep `google-key.json`
private — it is a password file.

## Where is my data?

Everything is stored in the `data/` folder (`app.db`). **Back up that folder** regularly.
Reminders only send while the app is running — for 24/7 reminders, move the app to cloud
hosting later (Render / Railway / any small VPS); it is ready for that, just run `npm start` there.

## Files

- `server.js` – web app (login, appointments, settings, logs)
- `notifier.js` – sends email / WhatsApp / SMS, checks every 60 seconds for due reminders
- `db.js` – SQLite database (built into Node, nothing to install)
- `views/` – the pages, `public/style.css` – the look
