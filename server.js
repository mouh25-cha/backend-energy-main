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
            ...data,
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

// 🤖 OpenAI إعداد Chatbot
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
async function askOpenAI(question) {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [
                { role: "system", content: "أنت مساعد ذكي مختص في ترشيد استهلاك الطاقة." },
                { role: "user", content: question }
            ]
        });
        return response.choices[0].message.content.trim();
    } catch (error) {
        console.error("❌ خطأ أثناء الاتصال بـ OpenAI:", error.response?.data || error.message);
        throw new Error("حدث خطأ أثناء الاتصال بـ OpenAI.");
    }
}

// 📡 المسارات API
app.get("/", (req, res) => res.send("🚀 الخادم يعمل!"));

app.get("/energy", async (req, res) => {
    try {
        const data = await EnergyModel.find().sort({ timestamp: -1 }).limit(2000);
        res.json(data);
    } catch {
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
    } catch {
        res.status(500).send("❌ خطأ أثناء الحفظ.");
    }
});

// 💬 روبوت المحادثة
app.post("/chatbot", async (req, res) => {
    const { question } = req.body;
    if (!question) return res.status(400).send("يرجى إدخال سؤال.");
    try {
        const answer = await askOpenAI(question);
        res.json({ answer });
    } catch {
        res.status(500).send("❌ خطأ أثناء الحصول على إجابة من OpenAI.");
    }
});

// 🧪 اختبار اتصال OpenAI
app.get("/test-openai", async (req, res) => {
    try {
        const response = await openai.chat.completions.create({
            model: "gpt-3.5-turbo",
            messages: [{ role: "user", content: "مرحبا" }]
        });
        res.send(response.choices[0].message.content);
    } catch (error) {
        console.error("❌ خطأ في الاتصال بـ OpenAI:", error.message);
        res.status(500).send("فشل في الاتصال بـ OpenAI");
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
