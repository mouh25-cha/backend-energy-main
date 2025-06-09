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
const axios = require("axios");
const os = require("os"); // 🆕 لاكتشاف IP

const app = express();
const PORT = process.env.PORT || 5000;

// دالة للحصول على IP المحلي
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "127.0.0.1";
}
const HOST = getLocalIP();

// إعدادات وسطية
app.use(cors());
app.use(express.json());
app.use(helmet());
app.use(morgan("combined"));

// Rate limit
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: "🚫 تم تجاوز الحد الأقصى للطلبات. يرجى المحاولة لاحقًا."
});
app.use(limiter);

// اتصال بـ MongoDB
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true
})
.then(() => console.log("💾 تم الاتصال بقاعدة بيانات MongoDB"))
.catch(err => console.error("❌ خطأ في الاتصال بقاعدة البيانات:", err));

// نموذج البيانات
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

// MQTT
const mqttClient = mqtt.connect(process.env.MQTT_BROKER);

mqttClient.on("connect", () => {
  console.log("🔗 تم الاتصال بخادم MQTT");
  mqttClient.subscribe("maison/energie", err => {
    if (err) console.error("❌ فشل الاشتراك في MQTT:", err);
  });
});

mqttClient.on("message", async (topic, message) => {
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
    console.error("⚠️ خطأ أثناء معالجة رسالة MQTT:", error.message);
  }
});

// DeepSeek
async function askDeepSeek(question) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error("مفتاح DeepSeek غير موجود.");
  }

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

// chatbot
app.post("/chatbot", async (req, res) => {
  const { question } = req.body;
  if (!question) return res.status(400).json({ error: "يرجى إرسال سؤال." });

  if (process.env.DEEPSEEK_API_KEY) {
    try {
      const answer = await askDeepSeek(question);
      return res.json({ answer });
    } catch (error) {
      console.warn("⚠️ استخدم الرد المحلي بسبب فشل DeepSeek.");
    }
  }

  // ردود محلية
  const q = question.toLowerCase();
  let answer = "عذرًا، لم أفهم السؤال.";

  if (q.includes("طاقة")) {
    answer = "الطاقة هي القدرة على أداء الشغل. لتوفير الطاقة، استخدم الأجهزة الكهربائية بحكمة وأطفئها عند عدم الحاجة.";
  } else if (q.includes("ترشيد") || q.includes("توفير")) {
    answer = "لترشيد استهلاك الطاقة، قم بإطفاء الأجهزة غير المستخدمة، واستبدل المصابيح التقليدية بـ LED.";
  } else if (q.includes("غاز")) {
    answer = "يجب التحقق من تسربات الغاز بشكل دوري واستخدام كاشفات الغاز لسلامتك.";
  }

  res.json({ answer });
});

// Routes API
app.get("/", (req, res) => {
  res.send("🚀 الخادم يعمل!");
});

app.get("/energy", async (req, res) => {
  try {
    const data = await EnergyModel.find().sort({ timestamp: -1 }).limit(2000);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: "❌ خطأ في جلب البيانات." });
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
  } catch (err) {
    res.status(500).json({ error: "❌ خطأ أثناء الحفظ." });
  }
});

// Swagger
const swaggerOptions = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "API إدارة الطاقة وكشف الغاز",
      version: "1.0.0",
      description: "API لجمع بيانات استهلاك الطاقة والمياه وكشف الغاز"
    },
    servers: [{ url: `http://${HOST}:${PORT}` }]
  },
  apis: ["server.js"]
};
const swaggerDocs = swaggerJsDoc(swaggerOptions);
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// تشغيل الخادم
app.listen(PORT, HOST, () => {
  console.log(`🚀 الخادم يعمل على http://${HOST}:${PORT}`);
});
