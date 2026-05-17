const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const youtubedlPath = require('youtube-dl-exec').constants.YOUTUBE_DL_PATH;
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
const ffprobeInstaller = require('@ffprobe-installer/ffprobe');

// bin klasörünü oluşturup içlerine ffmpeg ve ffprobe kopyalayalım
// Bu sayede hem ffmpeg hem de ffprobe aynı klasörde olur ve yt-dlp problemsiz çalışır!
const binPath = path.join(__dirname, 'bin');
if (!fs.existsSync(binPath)) {
    fs.mkdirSync(binPath, { recursive: true });
}

const ffmpegBinaryName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
const ffprobeBinaryName = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';

const targetFfmpeg = path.join(binPath, ffmpegBinaryName);
const targetFfprobe = path.join(binPath, ffprobeBinaryName);

try {
    if (!fs.existsSync(targetFfmpeg)) {
        fs.copyFileSync(ffmpegInstaller.path, targetFfmpeg);
        fs.chmodSync(targetFfmpeg, 0o755); // Unix/Linux için çalıştırma izni
    }
    if (!fs.existsSync(targetFfprobe)) {
        fs.copyFileSync(ffprobeInstaller.path, targetFfprobe);
        fs.chmodSync(targetFfprobe, 0o755); // Unix/Linux için çalıştırma izni
    }
    console.log(`[Sistem] FFmpeg ve FFprobe başarıyla hazırlandı: ${binPath}`);
} catch (copyError) {
    console.error('[Sistem] FFmpeg/FFprobe hazırlama hatası:', copyError);
}

const app = express();
const PORT = process.env.PORT || 3000;

// CORS izinleri ve public klasörünü statik olarak sunma
app.use(cors());
app.use(express.static('public'));

// Dosya isminde hata yaratabilecek karakterleri temizleme fonksiyonu
function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
}

// Yerel olarak yt-dlp çalıştıran ham spawn fonksiyonu (Klasör yollarındaki boşluk hatalarını engeller)
function runYtDlp(url, args) {
    return new Promise((resolve, reject) => {
        const processArgs = [url].concat(args);
        console.log(`[Sistem] yt-dlp tetikleniyor: ${youtubedlPath} ${processArgs.join(' ')}`);
        
        const child = spawn(youtubedlPath, processArgs);
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        
        child.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(`Süreç sonlandı (Kod: ${code}). Hata: ${stderr}`));
            }
        });
        
        child.on('error', (err) => {
            reject(err);
        });
    });
}

app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    const format = req.query.format; // 'mp3' or 'mp4'

    if (!videoUrl) {
        return res.status(400).send('URL parametresi gereklidir.');
    }

    try {
        console.log(`[Yeni İstek] URL: ${videoUrl} | Format: ${format}`);
        
        // Video bilgilerini çekmeye çalışalım, hata alırsa varsayılan isimle devam edelim (Defansif Programlama)
        let title = 'yutup_indir';
        try {
            const infoStdout = await runYtDlp(videoUrl, ['--dump-single-json', '--no-warnings']);
            const info = JSON.parse(infoStdout);
            if (info && info.title) {
                title = info.title;
            }
        } catch (infoError) {
            console.warn('[Sistem] Video başlığı alınamadı, varsayılan isim kullanılacak:', infoError.message);
        }
        
        const safeTitle = sanitizeFilename(title);
        
        // Aynı anda çoklu işlemlerde dosya karışıklığını önlemek için benzersiz id
        const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 10000);
        const relativeOutputPath = `${uniqueId}.${format}`;
        const outputPath = path.join(__dirname, relativeOutputPath);
        
        let dlArgs = [];
        
        if (format === 'mp3') {
            dlArgs = [
                '--extract-audio',
                '--audio-format', 'mp3',
                '--audio-quality', '0',
                '--output', relativeOutputPath,
                '--ffmpeg-location', binPath,
                '--no-warnings'
            ];
        } else {
            // Yüksek kalite HD/4K MP4 (Ses ve görüntüyü birleştirip en yüksek kaliteyi verir)
            dlArgs = [
                '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                '--merge-output-format', 'mp4',
                '--output', relativeOutputPath,
                '--ffmpeg-location', binPath,
                '--no-warnings'
            ];
        }

        console.log(`İndirme başlatıldı: ${safeTitle}`);
        // yt-dlp binary'sini doğrudan ham argümanlarla tetikliyoruz
        await runYtDlp(videoUrl, dlArgs);
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
