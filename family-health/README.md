# Family Health

A private, offline-first app for recording your family's health: medications and daily doses, temperature, weight, height and blood pressure readings, clinic visits and sick days (with photos of prescriptions and lab reports), vaccinations, appointments, and a printable **emergency card** for each person.

It is built for one household (for example you, your wife and two daughters) and runs on any phone or computer as an installable web app (PWA). It has no server, no account and no tracking.

---

## Design principles (the "best practice" choices)

| Principle | How the app does it |
|---|---|
| **Privacy first** | All data stays in the browser's IndexedDB on your device. Nothing is uploaded, and there are no analytics or third-party scripts. |
| **Works offline** | A service worker caches the app, so it opens in a clinic basement or on a plane. |
| **You own your data** | One-tap backup to a single `.json` file, which includes photos. The same file restores everything or moves it to another phone. |
| **Encrypted backups** | Backups are encrypted with AES-256-GCM using a key derived from your password (PBKDF2-SHA256, 310k iterations), so they are safe to keep in Google Drive or iCloud. |
| **Backup nudges** | The Today screen reminds you if you have not backed up in 30 days. The app also asks the browser for persistent storage so data is not cleared automatically. |
| **App lock** | Optional PIN, stored as a salted SHA-256 hash. It locks again after 2 minutes in the background. |
| **Reliable reminders** | Web apps can't ring alarms while closed, so each medication and appointment can be exported to your phone's calendar (`.ics`) as repeating events with alerts. In-app notifications also work while the app is open. |
| **Child-safe "as needed" doses** | For PRN medicines such as paracetamol syrup, you can set a *minimum hours between doses* and a *maximum per day*. The app shows when the next dose is allowed and warns before you go over the limit. |
| **Fewer mistakes** | Ticking a dose counts down stock. You get low-stock alerts, a shopping list, and a 7-day adherence score. Tapping the same button again undoes it. |
| **Emergency-ready** | Each person has an emergency card with blood type, allergies (in red), conditions, current meds, emergency contact, doctor and insurance. You can print it, save it as a PDF, or screenshot it for the lock screen. |
| **Medical-grade history** | Records are dated and typed (clinic visit, lab result, dental and so on), with diagnosis, details and attachments. Photos are resized on the device to save space. |
| **Accessible & simple** | Mobile-first layout with large touch targets, a bottom tab bar, light and dark mode, and print styles. There is no build step and no dependencies. |
| **Not a doctor** | Readings are only flagged (fever ≥ 38 °C, BP ≥ 140/90, SpO₂ < 95%). The app keeps records; it does not diagnose. |

## What you can record

- **Family members**: name, relation, date of birth (age shown automatically), sex, blood type, allergies, conditions, IC/ID number, insurance or panel clinic, regular doctor, emergency contact, notes and a colour.
- **Medications**: dose, form, purpose, schedule (daily / specific weekdays / as needed), times, food instructions, start and end dates (for example a 7-day antibiotic course), stock, refill threshold and prescriber.
- **Today screen**: everyone's doses for today, which you tick off. It also shows overdue doses, PRN logs, alerts (low stock, vaccines due, fever), the next 14 days of appointments and backup status.
- **Readings**: weight, height (growth chart for the girls), temperature, blood pressure, heart rate, blood glucose and SpO₂, each with a chart.
- **History**: clinic visits, hospital stays, illnesses, lab results, dental, eye and imaging, with photo and PDF attachments.
- **Vaccinations**: dose, date, batch number, where given, and next due date (shown on Today 30 days ahead).
- **Appointments**: date and time, clinic, address, questions to ask, outcome afterwards, and export to your calendar.

## Getting started

1. Open the app and tap **Set up my family (me, wife, 2 daughters)**. This creates *Me*, *Wife*, *Kakak* and *Adik*.
2. Tap each person and use **Edit profile** to add their real name, birthday, blood type and allergies.
3. Add current medications. For each daily medicine, tap **📅 Phone reminders** to get real alarms.
4. Go to **Backup → Export encrypted backup** and store the file in your cloud drive. Do this monthly.

To use it on your wife's phone, export a backup and restore it there. Each phone keeps its own copy; it does not sync live.

## Running it

It is a static site, so any web server works:

```bash
cd family-health
python3 -m http.server 8080
# open http://localhost:8080
```

### Install on your phones (recommended: GitHub Pages)

1. Already set up: every push to `main` that changes `family-health/` deploys automatically via `.github/workflows/pages.yml`. (If Pages is not yet enabled, go to **Settings → Pages → Source: GitHub Actions** once.)
2. Open **https://zulkola84.github.io/MechyExpert/** on your phone.
3. **Android (Chrome):** menu → *Add to Home screen / Install app*. **iPhone (Safari):** Share → *Add to Home Screen*.

Your health data is **not** stored on GitHub. Pages only serves the empty app; each phone keeps its own data locally.

## Files

```
family-health/
├── index.html            App shell and navigation
├── styles.css            Design tokens, light/dark themes, print styles
├── app.js                Storage, forms, views, scheduling, backup/encryption, lock
├── sw.js                 Offline cache (bump VERSION when shell files change)
├── manifest.webmanifest  Install metadata
└── icons/                App icons (SVG + 192/512 PNG)
```

## Ideas for later

- Live sync between your phone and your wife's phone (would need a server or end-to-end-encrypted sync).
- Malaysian national immunisation schedule (NIP) templates for the girls.
- Menstrual cycle and pregnancy tracking, and a symptom diary with photos.
- WHO growth percentile curves on the height and weight charts.
