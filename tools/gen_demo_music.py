# Generates 3 royalty-free demo tracks (synth arpeggios) + SVG artwork. Run from project root.
import wave, math, json, os, struct
R, D = 22050, 40
os.makedirs('music/audio', exist_ok=True); os.makedirs('music/artwork', exist_ok=True)
S = [('song001','Neon Drive','Demo Artist','Demo EP',[220,277,330,440],'#ff4d8d','#ffb84d'),
     ('song002','Midnight Loop','Demo Artist','Demo EP',[196,233,294,392],'#5b3df5','#ff4d8d'),
     ('song003','Sunrise Pulse','Demo Artist','Demo EP',[262,330,392,523],'#ffb84d','#2dd4bf')]
lib = []
for i, t, a, al, n, c1, c2 in S:
    w = wave.open(f'music/audio/{i}.wav', 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(R)
    fr = bytearray()
    for k in range(R * D):
        tt = k / R; ph = (tt * 4) % 1; f = n[int(tt * 4) % 4]
        v = .5 * math.sin(2*math.pi*f*tt) * math.exp(-3*ph) + .25 * math.sin(math.pi*f*tt)
        v += .4 * math.sin(2*math.pi*55*ph) * math.exp(-9*ph) * (int(tt*4) % 2 == 0)
        fr += struct.pack('<h', int(max(-1, min(1, v)) * 18000))
    w.writeframes(bytes(fr)); w.close()
    open(f'music/artwork/{i}.svg', 'w').write(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{c1}"/><stop offset="1" stop-color="{c2}"/></linearGradient></defs><rect width="400" height="400" fill="url(#g)"/><circle cx="200" cy="200" r="110" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width="12"/><circle cx="200" cy="200" r="40" fill="#fff" fill-opacity=".8"/></svg>')
    lib.append(dict(id=i, title=t, artist=a, album=al, artwork=f'/music/artwork/{i}.svg', audio=f'/music/audio/{i}.wav', duration=D))
json.dump(lib, open('music/library.json', 'w'), indent=2)
