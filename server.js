const express = require('express');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS izinleri ve public klasörünü statik olarak sunma
app.use(cors());
app.use(express.static('public'));

// Dosya isminde hata yaratabilecek karakterleri temizleme fonksiyonu
function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    const format = req.query.format; // 'mp3' or 'mp4'

    if (!videoUrl) {
        return res.status(400).send('URL parametresi gereklidir.');
    }

    try {
        console.log(`[Yeni İstek] URL: ${videoUrl} | Format: ${format}`);
        
        // Önce video bilgilerini çekelim (Başlık vs)
        const info = await youtubedl(videoUrl, { dumpJson: true, noWarnings: true });
        const title = info.title || 'yutup_indir_video';
        const safeTitle = sanitizeFilename(title);
        
        // Aynı anda çoklu işlemlerde dosya karışıklığını önlemek için benzersiz id
        const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 10000);
        const outputPath = path.join(__dirname, `${uniqueId}.${format}`);
        
        let dlOptions = {};
        
        if (format === 'mp3') {
            dlOptions = {
                extractAudio: true,
                audioFormat: 'mp3',
                audioQuality: 0, // En yüksek kalite (320kbps)
                output: outputPath,
                noWarnings: true
            };
        } else {
            // Yüksek kalite HD/4K MP4 (Sunucuda ffmpeg varsa ses ve görüntüyü birleştirip en yüksek kaliteyi verir)
            dlOptions = {
                format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                mergeOutputFormat: 'mp4',
                output: outputPath,
                noWarnings: true
            };
        }

        console.log(`İndirme başlatıldı: ${safeTitle}`);
        // yt-dlp binary'sini kullanarak indirmeyi gerçekleştir
        await youtubedl(videoUrl, dlOptions);
        console.log(`İndirme ve dönüştürme bitti. İstemciye aktarılıyor...`);

        // Dosyayı İstemciye (Kullanıcıya) Gönder
        res.download(outputPath, `${safeTitle}.${format}`, (err) => {
            if (err) {
                console.error('Dosya gönderim hatası:', err);
            }
            // Sunucuda yer kaplamaması için gönderildikten sonra dosyayı sil
            fs.unlink(outputPath, (unlinkErr) => {
                if (unlinkErr) console.error('Geçici dosya silinemedi:', unlinkErr);
                else console.log('Geçici dosya sunucudan temizlendi.');
            });
        });

    } catch (error) {
        console.error('Sunucu veya dönüştürme hatası:', error);
        res.status(500).send('Video indirilirken bir hata oluştu. Link engellenmiş veya kısıtlı olabilir.');
    }
});

// Masaüstü (Electron) veya diğer modüllerden başlatılabilmesi için fonksiyon
function startServer() {
    return new Promise((resolve) => {
        // Port 0 vererek sistemin boş bir port atamasını sağlıyoruz
        const serverInfo = app.listen(0, () => {
            const dynamicPort = serverInfo.address().port;
            console.log(`Arka plan motoru ${dynamicPort} portunda çalışıyor.`);
            resolve(dynamicPort);
        });
    });
}

// Eğer bu dosya doğrudan çalıştırılırsa (örneğin cPanel'de veya node server.js)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`=========================================`);
        console.log(`🚀 Yutup İndir Web Sunucusu Başlatıldı!`);
        console.log(`📌 Port: ${PORT}`);
        console.log(`🌐 Arayüze ulaşmak için: http://localhost:${PORT}`);
        console.log(`=========================================`);
    });
}

module.exports = { startServer, app };
