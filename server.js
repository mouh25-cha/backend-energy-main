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
const axios = require("axios"); // ✅ بدل OpenAI

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
    puissance: Number,
    delayMs: Number,
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
        const dataTime = new Date(data.timestamp).getTime();
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

// 🤖 دالة الاتصال بـ DeepSeek
async function askDeepSeek(question) {
    try {
        const response = await axios.post(
            "https://api.deepseek.com/v1/chat/completions",
            {
                model: "deepseek-chat",
                messages: [
                    { role: "system", content: "أنت مساعد ذكي في ترشيد استهلاك الطاقة." },
                    { role: "user", content: question }
                ]
            },
            {
                headers: {
                    "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );
        return response.data.choices[0].message.content.trim();
    } catch (error) {
        console.error("❌ خطأ أثناء الاتصال بـ DeepSeek:", error.response?.data || error.message);
        throw new Error("فشل الاتصال بـ DeepSeek.");
    }
}

// 📡 المسارات API
app.get("/", (req, res) => {
    res.send("🚀 الخادم يعمل!");
});

app.get("/energy", async (req, res) => {
    try {
        const data = await EnergyModel.find().sort({ timestamp: -1 }).limit(2000);
        res.json(data);
    } catch (error) {
        res.status(500).send("❌ خطأ في جلب البيانات.");
    }
});

app.post("/energy", async (req, res) => {
    const schema = Joi.object({
        temperature: Joi.number(),
        humidity: Joi.number(),
        voltage: Joi.number(),
        current_20A: Joi.number(),
        current_30A: Joi.number(),
        sct013: Joi.number(),
        waterFlow: Joi.number(),
        gasDetected: Joi.number(),
        level: Joi.number()
    });

    const { error } = schema.validate(req.body);
    if (error) return res.status(400).send(error.details[0].message);

    try {
        const newData = new EnergyModel(req.body);
        await newData.save();
        res.status(201).json({ message: "📊 تم حفظ البيانات بنجاح!" });
    } catch (error) {
        res.status(500).send("❌ خطأ أثناء الحفظ.");
    }
});

// 💬 مسار دردشة Chatbot مع DeepSeek
app.post("/chatbot", async (req, res) => {
    const { question } = req.body;
    if (!question) return res.status(400).send("يرجى إرسال سؤال.");

    try {
        const answer = await askDeepSeek(question);
        res.json({ answer });
    } catch (error) {
        res.status(500).send("❌ حدث خطأ أثناء معالجة السؤال.");
    }
});

// 📚 توثيق Swagger
const swaggerOptions = {
    definition: {
        openapi: "3.0.0",
        info: {
            title: "API إدارة الطاقة وكشف الغاز",
            version: "1.0.0",
            description: "API لجمع بيانات استهلاك الطاقة والمياه وكشف الغاز"
        },
        servers: [{ url: `http://localhost:${PORT}` }]
    },
    apis: ["server.js"]
};
const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// 🚀 تشغيل الخادم
app.listen(PORT, () => {
    console.log(`🚀 الخادم يعمل على http://localhost:${PORT}`);
});
