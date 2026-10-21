package com.noyon.snake;

import org.java_websocket.WebSocket;
import org.java_websocket.handshake.ClientHandshake;
import org.java_websocket.server.WebSocketServer;
import org.json.JSONObject;

import java.net.InetSocketAddress;
import java.util.HashMap;
import java.util.Map;

/**
 * The same room relay as server/server.js, running on the host phone for hotspot games.
 * One room per phone: the host connects from 127.0.0.1 and sends "create"; friends send "join".
 */
public class LocalRelay extends WebSocketServer {
    private WebSocket host;
    private final Map<WebSocket, Integer> ids = new HashMap<>();
    private final Map<Integer, WebSocket> players = new HashMap<>();
    private int nextId = 1;

    public LocalRelay(int port) {
        super(new InetSocketAddress(port));
        setConnectionLostTimeout(30);
    }

    @Override
    public void onOpen(WebSocket conn, ClientHandshake handshake) {}

    @Override
    public synchronized void onClose(WebSocket conn, int code, String reason, boolean remote) {
        if (conn == host) {
            for (WebSocket p : players.values()) {
                try { p.send("{\"t\":\"hostgone\"}"); p.close(); } catch (Exception ignored) {}
            }
            players.clear(); ids.clear(); host = null;
            return;
        }
        Integer id = ids.remove(conn);
        if (id != null) {
            players.remove(id);
            sendHost("{\"t\":\"left\",\"id\":" + id + "}");
        }
    }

    private void sendHost(String s) {
        if (host != null && host.isOpen()) try { host.send(s); } catch (Exception ignored) {}
    }

    @Override
    public synchronized void onMessage(WebSocket conn, String text) {
        JSONObject m;
        try { m = new JSONObject(text); } catch (Exception e) { return; }
        String t = m.optString("t");
        try {
            switch (t) {
                case "ping":
                    conn.send("{\"t\":\"pong\"}");
                    break;
                case "create":
                    host = conn;
                    conn.send("{\"t\":\"created\",\"code\":\"HOT\",\"id\":0}");
                    break;
                case "join":
                    if (host == null) { conn.send("{\"t\":\"error\",\"msg\":\"nocode\"}"); break; }
                    if (players.size() >= 9) { conn.send("{\"t\":\"error\",\"msg\":\"full\"}"); break; }
                    int id = nextId++;
                    ids.put(conn, id); players.put(id, conn);
                    conn.send("{\"t\":\"joined\",\"id\":" + id + "}");
                    sendHost("{\"t\":\"peer\",\"id\":" + id + "}");
                    break;
                case "to":
                    if (conn != host) break;
                    String out = m.get("m").toString();
                    if (m.isNull("id") || !m.has("id")) {
                        for (WebSocket p : players.values()) if (p.isOpen()) p.send(out);
                    } else {
                        WebSocket p = players.get(m.getInt("id"));
                        if (p != null && p.isOpen()) p.send(out);
                    }
                    break;
                case "kick":
                    if (conn != host) break;
                    WebSocket k = players.get(m.getInt("id"));
                    if (k != null) k.close();
                    break;
                case "up":
                    Integer from = ids.get(conn);
                    if (from == null) break;
                    sendHost("{\"t\":\"from\",\"id\":" + from + ",\"m\":" + m.get("m").toString() + "}");
                    break;
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onError(WebSocket conn, Exception ex) {}

    @Override
    public void onStart() {}
}
