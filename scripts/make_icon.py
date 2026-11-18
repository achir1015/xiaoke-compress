# 產生程式圖示：小柯機器人（頭盔造型）＋被上下箭頭壓扁的 MP4 影片檔
import os
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S = 1024
NAVY = (22, 52, 104, 255)


def layer():
    return Image.new('RGBA', (S, S), (0, 0, 0, 0))


def font(size):
    for f in ('C:/Windows/Fonts/arialbd.ttf', '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf'):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


img = layer()
bg = layer()
d = ImageDraw.Draw(bg)
d.rounded_rectangle((36, 36, 988, 988), 190, fill=NAVY)
d.rounded_rectangle((70, 70, 954, 954), 164, fill=(234, 242, 251, 255))
img = Image.alpha_composite(img, bg)

# --- 影片檔：橘色檔案卡（右上折角）、底片孔、播放鍵、MP4 字樣，被壓扁成寬扁形 ---------------
card = layer()
c = ImageDraw.Draw(card)
x0, y0, x1, y1 = 130, 400, 700, 720
fold = 90
ORANGE = (244, 110, 40, 255)
c.polygon([(x0 + 40, y0), (x1 - fold, y0), (x1, y0 + fold), (x1, y1 - 40), (x0, y1 - 40), (x0, y0 + 40)], fill=ORANGE)
c.rounded_rectangle((x0, y0, x1, y1), 44, fill=ORANGE)
c.polygon([(x1 - fold, y0 - 2), (x1 + 2, y0 - 2), (x1 + 2, y0 + fold)], fill=(234, 242, 251, 255))
c.polygon([(x1 - fold, y0), (x1 - fold, y0 + fold), (x1, y0 + fold)], fill=(255, 176, 120, 255))
# 底片孔
for i in range(7):
    hx = x0 + 52 + i * 66
    c.rounded_rectangle((hx, y0 + 26, hx + 34, y0 + 52), 7, fill=(255, 226, 205, 255))
    c.rounded_rectangle((hx, y1 - 52, hx + 34, y1 - 26), 7, fill=(255, 226, 205, 255))
# 播放鍵
pcx, pcy = x0 + 150, (y0 + y1) // 2
c.ellipse((pcx - 82, pcy - 82, pcx + 82, pcy + 82), fill=(255, 255, 255, 255))
c.polygon([(pcx - 26, pcy - 44), (pcx - 26, pcy + 44), (pcx + 48, pcy)], fill=ORANGE)
# MP4
f = font(150)
c.text((x0 + 262, pcy), 'MP4', font=f, fill=(255, 255, 255, 255), anchor='lm')
sh = layer()
ImageDraw.Draw(sh).rounded_rectangle((x0 + 10, y0 + 30, x1 + 20, y1 + 30), 50, fill=(0, 0, 0, 90))
img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(22)))
img = Image.alpha_composite(img, card)

# --- 壓縮箭頭：上下往內 -------------------------------------------------------------
arr = layer()
a = ImageDraw.Draw(arr)
GREEN = (30, 190, 130, 255)
ax = (x0 + x1) // 2


def arrow(tip_y, direction):
    # direction=1 往下、-1 往上；箭桿在箭頭後方
    ya, yb = sorted((tip_y - direction * 200, tip_y - direction * 80))
    a.rounded_rectangle((ax - 34, ya, ax + 34, yb), 18, fill=GREEN)
    a.polygon([(ax - 100, tip_y - direction * 100), (ax + 100, tip_y - direction * 100), (ax, tip_y)], fill=GREEN)


arrow(y0 - 18, 1)
arrow(y1 + 18, -1)
img = Image.alpha_composite(img, arr)

# --- 小柯機器人（頭盔造型），右上 ---------------------------------------------------
rb = layer()
r_ = ImageDraw.Draw(rb)
cx, cy = 760, 270
s = 0.66


def R(p, q, u, v):
    return (cx + p * s, cy + q * s, cx + u * s, cy + v * s)


r_.line((cx, cy - 250 * s, cx, cy - 190 * s), fill=(90, 100, 120, 255), width=16)
r_.ellipse(R(-34, -290, 34, -222), fill=(255, 196, 40, 255))
r_.rounded_rectangle(R(-262, -70, -210, 80), 20, fill=(40, 120, 220, 255))
r_.rounded_rectangle(R(210, -70, 262, 80), 20, fill=(40, 120, 220, 255))
r_.ellipse(R(-230, -210, 230, 220), fill=(70, 150, 240, 255))
r_.ellipse(R(-214, -196, 214, 200), fill=(240, 246, 255, 255))
r_.rounded_rectangle(R(-170, -110, 170, 90), int(90 * s), fill=(24, 36, 64, 255))
for ex in (-72, 72):
    r_.arc(R(ex - 46, -50, ex + 46, 30), 200, 340, fill=(90, 230, 255, 255), width=18)
r_.arc(R(-50, 10, 50, 70), 20, 160, fill=(90, 230, 255, 255), width=12)
r_.ellipse(R(-160, 40, -110, 80), fill=(255, 140, 160, 200))
r_.ellipse(R(110, 40, 160, 80), fill=(255, 140, 160, 200))
sh2 = layer()
ImageDraw.Draw(sh2).ellipse(R(-240, -190, 260, 260), fill=(0, 0, 0, 110))
img = Image.alpha_composite(img, sh2.filter(ImageFilter.GaussianBlur(22)))
img = Image.alpha_composite(img, rb)

os.makedirs(os.path.join(ROOT, 'build'), exist_ok=True)
img.save(os.path.join(ROOT, 'build', 'icon.png'))
img.save(os.path.join(ROOT, 'build', 'icon.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
pub = os.path.join(ROOT, 'public')
os.makedirs(pub, exist_ok=True)
img.resize((512, 512), Image.LANCZOS).save(os.path.join(pub, 'icon-512.png'))
img.resize((192, 192), Image.LANCZOS).save(os.path.join(pub, 'icon-192.png'))
img.resize((180, 180), Image.LANCZOS).save(os.path.join(pub, 'apple-touch-icon.png'))
img.resize((64, 64), Image.LANCZOS).save(os.path.join(pub, 'favicon.png'))
img.resize((128, 128), Image.LANCZOS).save(os.path.join(pub, 'logo.png'))
# iPhone／iPad：App 圖示（不透明，iOS 會自己裁圓角）與線上安裝頁圖示
full = Image.new('RGBA', (S, S), NAVY)
full = Image.alpha_composite(full, img)
appicon = os.path.join(ROOT, 'ios', 'XiaokeCompress', 'Assets.xcassets', 'AppIcon.appiconset')
if os.path.isdir(appicon):
    full.convert('RGB').save(os.path.join(appicon, 'icon-1024.png'))
pios = os.path.join(pub, 'ios')
if os.path.isdir(pios):
    for n in (512, 180, 57):
        full.convert('RGB').resize((n, n), Image.LANCZOS).save(os.path.join(pios, f'icon-{n}.png'))
    try:
        import qrcode
        qrcode.make('https://achir1015.github.io/xiaoke-compress/ios/', box_size=8, border=2).save(os.path.join(pios, 'qr.png'))
        print('qr ok')
    except ImportError:
        print('沒有 qrcode 套件，QR Code 沒更新')
for dd, n in (('mdpi', 48), ('hdpi', 72), ('xhdpi', 96), ('xxhdpi', 144), ('xxxhdpi', 192)):
    folder = os.path.join(ROOT, 'android', 'res', f'mipmap-{dd}')
    if os.path.isdir(folder):
        img.resize((n, n), Image.LANCZOS).save(os.path.join(folder, 'ic_launcher.png'))
print('icon ok')
