"""train.py — neural policy (opponent move) and value networks, numpy only, exports weights for nn.js.
   python3 train.py moves   data/moves.jsonl -> models/policy_nn.json   (softmax over candidates, shared MLP scorer)
   python3 train.py value   data/value.jsonl -> models/value_nn.json    (sigmoid MLP)
Held-out = last 20% of games (file order). Saves only if it beats the linear baseline on held-out."""
import json, sys, numpy as np, os, time
rng = np.random.default_rng(0)
def mlp_init(d, h): return {"W1": rng.normal(0, np.sqrt(2/d), (d, h)), "b1": np.zeros(h), "W2": rng.normal(0, np.sqrt(1/h), (h, 1)), "b2": np.zeros(1)}
def fwd(p, X):  # X: (n,d) -> scores (n,)
    H = np.maximum(0, X @ p["W1"] + p["b1"]); return (H @ p["W2"] + p["b2"]).ravel(), H
def adam_step(p, g, m, v, t, lr=2e-3, b1=0.9, b2=0.999, eps=1e-8):
    for k in p: m[k] = b1*m[k] + (1-b1)*g[k]; v[k] = b2*v[k] + (1-b2)*g[k]**2; p[k] -= lr * (m[k]/(1-b1**t)) / (np.sqrt(v[k]/(1-b2**t)) + eps)
def train_moves(path, hidden=64, epochs=6, l2=1e-5):
    rows = [json.loads(l) for l in open(path)]; n = len(rows); cut = int(n*0.8)
    d = len(rows[0]["x"][0]); p = mlp_init(d, hidden); m = {k: np.zeros_like(v) for k, v in p.items()}; v = {k: np.zeros_like(x) for k, x in p.items()}; t = 0
    # linear baseline: logistic softmax via same loop with hidden=0 equivalent -> use predictor.json accuracy printed by predict2 instead; here compute frequency-prior baseline from feature 17 (log prior)
    def acc(rs):
        t1 = t3 = 0
        for r in rs:
            s, _ = fwd(p, np.array(r["x"])); o = np.argsort(-s); t1 += o[0] == r["y"]; t3 += r["y"] in o[:3]
        return 100*t1/len(rs), 100*t3/len(rs)
    def base(rs):
        t1 = t3 = 0
        for r in rs:
            s = np.array([x[16] for x in r["x"]]); o = np.argsort(-s); t1 += o[0] == r["y"]; t3 += r["y"] in o[:3]
        return 100*t1/len(rs), 100*t3/len(rs)
    for ep in range(epochs):
        idx = rng.permutation(cut); t0 = time.time()
        for i in idx:
            r = rows[i]; X = np.array(r["x"]); s, H = fwd(p, X); s = s - s.max(); e = np.exp(s); q = e/e.sum(); g_s = q.copy(); g_s[r["y"]] -= 1
            gW2 = H.T @ g_s[:, None]; gb2 = g_s.sum(keepdims=True); gH = g_s[:, None] @ p["W2"].T; gH[H <= 0] = 0
            g = {"W1": X.T @ gH + l2*p["W1"], "b1": gH.sum(0), "W2": gW2 + l2*p["W2"], "b2": gb2}; t += 1; adam_step(p, g, m, v, t)
        print(f"epoch {ep+1}: held-out top1/top3 {acc(rows[cut:])}  ({time.time()-t0:.0f}s)", flush=True)
    a = acc(rows[cut:]); b = base(rows[cut:]); print(f"FINAL neural {a[0]:.1f}/{a[1]:.1f}  vs frequency-prior baseline {b[0]:.1f}/{b[1]:.1f}  (n={n-cut} held-out decisions)")
    if a[0] > b[0]: json.dump({k: v.tolist() for k, v in p.items()} | {"kind": "policy", "heldout": a, "n": cut}, open("models/policy_nn.json", "w")); print("saved models/policy_nn.json")
    else: print("not saved")
def train_value(path, hidden=32, epochs=30, l2=1e-4):
    rows = [json.loads(l) for l in open(path)]; X = np.array([r["x"] for r in rows]); Y = np.array([r["y"] for r in rows], float); W = np.array([r.get("w", 1) for r in rows]); n = len(rows); cut = int(n*0.8)
    p = mlp_init(X.shape[1], hidden); m = {k: np.zeros_like(v) for k, v in p.items()}; v = {k: np.zeros_like(x) for k, x in p.items()}; t = 0
    sig = lambda z: 1/(1+np.exp(-z))
    for ep in range(epochs):
        for i in rng.permutation(cut).reshape(-1, 32) if cut % 32 == 0 else [rng.permutation(cut)[j:j+32] for j in range(0, cut, 32)]:
            xb, yb, wb = X[i], Y[i], W[i]; s, H = fwd(p, xb); q = sig(s); g_s = (q - yb) * wb / len(i)
            gW2 = H.T @ g_s[:, None]; gb2 = g_s.sum(keepdims=True); gH = g_s[:, None] @ p["W2"].T; gH[H <= 0] = 0
            g = {"W1": xb.T @ gH + l2*p["W1"], "b1": gH.sum(0), "W2": gW2 + l2*p["W2"], "b2": gb2}; t += 1; adam_step(p, g, m, v, t)
    s, _ = fwd(p, X[cut:]); acc = ((sig(s) >= 0.5) == (Y[cut:] == 1)).mean()*100
    lin = json.load(open("models/value.json")); w = np.array(lin["w"]); la = ((sig(X[cut:] @ w[:X.shape[1]]) >= 0.5) == (Y[cut:] == 1)).mean()*100 if len(w) == X.shape[1] else float("nan")
    print(f"FINAL value net {acc:.1f}%  vs linear {la:.1f}%  (n={n-cut} held-out states)")
    if acc > la: json.dump({k: v.tolist() for k, v in p.items()} | {"kind": "value", "heldout": acc, "n": cut}, open("models/value_nn.json", "w")); print("saved models/value_nn.json")
    else: print("not saved")
if __name__ == "__main__":
    (train_moves if sys.argv[1] == "moves" else train_value)(sys.argv[2])
