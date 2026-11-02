# 455 Groceries Inventory Status

Peek here before you buy! Avoid Food Waste. Listen to your Wife at all times!

A shared household groceries inventory. Check it before buying so nothing gets bought twice.

- **At home**: everything in the Fridge, Freezer, Pantry and Household, with +/− counts
- **To buy**: only items that are running low or out, with a "Bought" button and a copy-for-WhatsApp list
- **Use first**: items expiring in the next 3 days

## How it's built

- A single `index.html` page, hosted on Vercel
- Data is stored in Supabase (table `groceries_items`) and updates live on every open phone
- No login: anyone with the link can view and edit the list

Built for the AIA course *AI for Automation: Build AI Workflows* (Activity 1.1).
