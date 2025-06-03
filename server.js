// 📦 الاستدعاءات الأولية
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const mqtt = require("mqtt");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const morgan = require("morgan");
const swaggerUi = require("swagger-ui-express");
const swaggerJsDoc = require("swagger-jsdoc");
const Joi = require("joi");
const { OpenAI } = require("openai");

const app = express();
const PORT = process.env.PORT || 5000;

// 🔐 الأمان والوسيطات
app.use(cors());
app.use(express.json());
app.use(helmet());
app.use(morgan("combined"));

// ⚙️ تحديد حد للطلبات
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: "🚫 تم تجاوز الحد الأقصى للطلبات. يرجى المحاولة لاحقًا."
});
app.use(limiter);

// 🛢️ الاتصال بقاعدة البيانات MongoDB
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("💾 تم الاتصال بقاعدة بيانات MongoDB"))
    .catch(err => console.error("❌ خطأ في الاتصال بقاعدة البيانات:", err));

// 📊 نموذج البيانات
const EnergySchema = new mongoose.Schema({
    temperature: Number,
    humidity: Number,
    voltage: Number,
    current_20A: Number,
    current_30A: Number,
    sct013: Number,
    waterFlow: Number,
    gasDetected: Number,
    level: Number,
    puissance: Number, // 🆕 الطاقة المحسوبة
    delayMs: Number,    // 🆕 التأخير بين الإرسال والاستلام
    timestamp: { type: Date, default: Date.now }
});
const EnergyModel = mongoose.model("Energy", EnergySchema);

// 📡 الاتصال بخادم MQTT
const client = mqtt.connect(process.env.MQTT_BROKER);

client.on("connect", () => {
    console.log("🔗 تم الاتصال بخادم MQTT");
    client.subscribe("maison/energie");
});

client.on("message", async (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        const now = Date.now();
        const dataTime = new Date(data.timestamp).getTime(); // تأكد أن ESP32 يرسل "timestamp"
        const delayMs = now - dataTime;

        const puissance = (data.sct013 ?? 0) * (data.voltage ?? 0);

        const newEntry = new EnergyModel({
            temperature: data.temperature ?? null,
            humidity: data.humidity ?? null,
            voltage: data.voltage ?? null,
            current_20A: data.current_20A ?? null,
            current_30A: data.current_30A ?? null,
            sct013: data.sct013 ?? null,
            waterFlow: data.waterFlow ?? null,
            gasDetected: data.gasDetected ?? null,
            level: data.level ?? null,
            puissance,
            delayMs,
            timestamp: data.timestamp ?? new Date()
        });

        await newEntry.save();
        console.log("✅ بيانات MQTT محفوظة. تأخير:", delayMs + "ms");
    } catch (error) {
        console.error("⚠️ خطأ أثناء معالجة رسالة MQTT:", error);
    }
});
