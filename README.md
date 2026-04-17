# Audit Observations Tracker Dashboard

This project is now connected to Firebase Firestore for shared saved changes.

## What is ready now

- Public-ready Vite + React frontend
- Shared observation data stored in Firebase Firestore
- Editable observation text, latest update, owner, and status
- Closed observations automatically move to the end
- First run automatically seeds Firestore if the collection is empty

## Local run

```bash
npm install
npm run dev
```

## Make it public with Vercel

1. Push this project to GitHub.
2. Open [Vercel](https://vercel.com/).
3. Click `Add New Project`.
4. Import your GitHub repository.
5. Confirm:
   - Build Command: `npm run build`
   - Output Directory: `dist`
6. Click `Deploy`.
7. Vercel will give you a public URL like:
   `https://your-project.vercel.app`

Official docs:
- [Vite on Vercel](https://vercel.com/docs/frameworks/vite)

## Firestore requirement before public launch

Your app now reads and writes to Firestore. Before publishing publicly, make sure your Firestore rules allow the dashboard to read and update data.

Example temporary rule for testing only:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /observations/{document} {
      allow read, write: if true;
    }
  }
}
```

Important:
- This is open to everyone and should only be used temporarily.
- For production, add authentication and proper rules.

## Recommended production path

1. Deploy frontend on Vercel.
2. Keep data in Firebase Firestore.
3. Add Firebase Authentication next if you want controlled access.

That gives you:
- a public URL
- shared saved changes for all users
- room to add login and permissions later
