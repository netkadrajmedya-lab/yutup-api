const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const https = require('https');
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
// Tarayıcının Content-Disposition header'ına erişebilmesi ve orijinal dosya adını alabilmesi için expose ediyoruz
app.use(cors({
    exposedHeaders: ['Content-Disposition']
}));
app.use(express.static('public'));

// Alternatif yüksek performanslı, coğrafi dağıtık YouTube indirme motoru listesi (Render IP engellemesini aşmak için)
const FALLBACK_APIS = [
    "https://cobaltapi.squair.xyz",
    "https://api.dl.woof.monster",
    "https://cobaltapi.kittycat.boo",
    "https://fox.kittycat.boo",
    "https://dog.kittycat.boo",
    "https://api.cobalt.blackcat.sweeux.org"
];

// Alternatif indirme sunucularını deneyen yardımcı fonksiyon (Eski Node sürümlerinde patlamaması için tamamen saf https ile yazıldı)
function tryCobaltDownload(videoUrl, format, quality = '1080') {
    return new Promise((resolve, reject) => {
        const payload = JSON.stringify({
            url: videoUrl,
            audioFormat: format === 'mp3' ? 'mp3' : 'best',
            downloadMode: format === 'mp3' ? 'audio' : 'auto',
            videoQuality: quality,
            youtubeVideoCodec: 'h264'
        });

        let currentApiIndex = 0;

        function attemptNext() {
            if (currentApiIndex >= FALLBACK_APIS.length) {
                return reject(new Error('Tüm alternatif indirme sunucuları başarısız oldu.'));
            }

            const api = FALLBACK_APIS[currentApiIndex];
            currentApiIndex++;

            console.log(`[Sistem] Cobalt alternatifi deneniyor: ${api}`);

            try {
                const urlObj = new URL(api);
                const options = {
                    hostname: urlObj.hostname,
                    port: urlObj.port || 443,
                    path: urlObj.pathname === '/' ? '/' : urlObj.pathname,
                    method: 'POST',
                    headers: {
                        'Accept': 'application/json',
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload)
                    },
                    timeout: 12000 // 12 saniye zaman aşımı
                };

                const req = https.request(options, (res) => {
                    let dataStr = '';
                    res.on('data', (chunk) => { dataStr += chunk; });
                    res.on('end', () => {
                        if (res.statusCode < 200 || res.statusCode >= 300) {
                            console.warn(`[Sistem] ${api} yanıt hatası: ${res.statusCode}`);
                            return attemptNext();
                        }

                        try {
                            const data = JSON.parse(dataStr);
                            if (data && (data.status === 'tunnel' || data.status === 'redirect') && data.url) {
                                console.log(`[Sistem] Cobalt indirme linki başarıyla alındı!`);
                                return resolve({ downloadUrl: data.url, filename: data.filename || 'yutup_indir' });
                            } else {
                                console.warn(`[Sistem] ${api} geçersiz yanıt yapısı:`, data);
                                attemptNext();
                            }
                        } catch (parseErr) {
                            console.warn(`[Sistem] ${api} JSON ayrıştırma hatası:`, parseErr.message);
                            attemptNext();
                        }
                    });
                });

                req.on('error', (err) => {
                    console.warn(`[Sistem] ${api} bağlantı hatası:`, err.message);
                    attemptNext();
                });

                req.on('timeout', () => {
                    console.warn(`[Sistem] ${api} zaman aşımına uğradı.`);
                    req.destroy();
                    attemptNext();
                });

                req.write(payload);
                req.end();

            } catch (err) {
                console.warn(`[Sistem] URL ayrıştırma hatası (${api}):`, err.message);
                attemptNext();
            }
        }

        attemptNext();
    });
}

// Dosya isminde hata yaratabilecek karakterleri temizleme fonksiyonu
function sanitizeFilename(name) {
    // Windows ve Linux dosya sistemleri için geçersiz karakterleri temizle (\ / : * ? " < > |)
    let cleanName = name.replace(/[\\/:*?"<>|]/g, '');
    // Çift boşlukları tek boşluğa düşür ve kenarlardaki boşlukları kırp
    cleanName = cleanName.replace(/\s+/g, ' ').trim();
    return cleanName || 'yutup_indir';
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
    const quality = req.query.quality || '1080'; // '1080', '720', '480', '360'

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
        
        const isRender = process.env.RENDER === 'true' || process.env.PORT !== undefined;

        // Render sunucusunda çalışıyorsak, CPU limitlerini ve YouTube IP bloklarını
        // aşmak ve indirmeyi 5 saniyeye düşürmek için doğrudan Cobalt Proxy motorunu öncelikli tetikliyoruz.
        if (isRender) {
            console.log(`[Sistem] Sunucu ortamı (Render) tespit edildi. Süper hızlı Cobalt indirme motoru öncelikli olarak tetikleniyor...`);
            try {
                const cobaltResult = await tryCobaltDownload(videoUrl, format, quality);
                console.log(`[Sistem] Cobalt indirme akışı başlatılıyor: ${cobaltResult.filename}`);
                
                const clientFilename = sanitizeFilename(cobaltResult.filename);
                
                return https.get(cobaltResult.downloadUrl, (cobaltStream) => {
                    if (cobaltStream.statusCode >= 400) {
                        return res.status(cobaltStream.statusCode).send('Akış indirme hatası.');
                    }
                    
                    res.setHeader('Content-Disposition', `attachment; filename="${clientFilename || safeTitle}.${format}"`);
                    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
                    
                    cobaltStream.pipe(res);
                }).on('error', (streamErr) => {
                    console.error('[Sistem] Cobalt akış hatası:', streamErr);
                    res.status(500).send('İndirme akışı sırasında hata oluştu.');
                });
            } catch (cobaltError) {
                console.warn('[Sistem] Cobalt sunucuda başarısız oldu, yedek yerel yt-dlp motoruna geri dönülüyor...', cobaltError.message);
                // Çökme durumunda yerel yt-dlp motorunu yedek olarak deneriz.
            }
        }
        
        // Aynı anda çoklu işlemlerde dosya karışıklığını önlemek için benzersiz id
        const uniqueId = Date.now() + '_' + Math.floor(Math.random() * 10000);
        const relativeOutputPath = `${uniqueId}.${format}`;
        const outputPath = path.join(__dirname, relativeOutputPath);
        
        let dlArgs = [];
        
        if (format === 'mp3') {
            dlArgs = [
                '--extract-audio',
                '--audio-format', 'mp3',
                '--audio-quality', '192K', // Süper hızlı transkod için 192kbps (Kayıpsız duyum)
                '--output', relativeOutputPath,
                '--ffmpeg-location', binPath,
                '--no-warnings'
            ];
        } else {
            // Dinamik Seçilen Kalitede MP4 (Kullanıcının tercihine göre)
            dlArgs = [
                '--format', `bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best`,
                '--merge-output-format', 'mp4',
                '--output', relativeOutputPath,
                '--ffmpeg-location', binPath,
                '--no-warnings'
            ];
        }

        try {
            console.log(`İndirme başlatıldı (Yerel): ${safeTitle}`);
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
        } catch (downloadError) {
            console.warn('[Sistem] Yerel indirme (yt-dlp) başarısız oldu, alternatif (Cobalt Proxy) deneniyor...', downloadError.message);
            
            try {
                const cobaltResult = await tryCobaltDownload(videoUrl, format, quality);
                console.log(`[Sistem] Alternatif indirme akışı başlatılıyor: ${cobaltResult.filename}`);
                
                const clientFilename = sanitizeFilename(cobaltResult.filename);
                
                https.get(cobaltResult.downloadUrl, (cobaltStream) => {
                    if (cobaltStream.statusCode >= 400) {
                        return res.status(cobaltStream.statusCode).send('Alternatif akış indirme hatası.');
                    }
                    
                    res.setHeader('Content-Disposition', `attachment; filename="${clientFilename || safeTitle}.${format}"`);
                    res.setHeader('Content-Type', format === 'mp3' ? 'audio/mpeg' : 'video/mp4');
                    
                    cobaltStream.pipe(res);
                    
                    cobaltStream.on('end', () => {
                        console.log('[Sistem] Alternatif dosya başarıyla akıtıldı ve tamamlandı.');
                    });
                }).on('error', (streamErr) => {
                    console.error('[Sistem] Alternatif akış hatası:', streamErr);
                    res.status(500).send('Alternatif indirme akışı sırasında hata oluştu.');
                });
                
            } catch (fallbackError) {
                console.error('[Sistem] Tüm indirme metotları başarısız oldu:', fallbackError.message);
                res.status(500).send('Video indirilirken bir hata oluştu. Link engellenmiş veya kısıtlı olabilir.');
            }
        }
    } catch (outerError) {
        console.error('[Sistem] Beklenmeyen sunucu hatası:', outerError);
        res.status(500).send('Sunucu tarafında beklenmedik bir hata oluştu.');
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
