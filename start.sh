#!/bin/bash
echo "Запуск Discord бота (Node.js)..."
cd bot
node bot.js &
cd ..

echo "Ожидание запуска WebSocket сервера (3 секунды)..."
sleep 3

echo "Запуск Headless моста (Python)..."
python3 headless_client.py
