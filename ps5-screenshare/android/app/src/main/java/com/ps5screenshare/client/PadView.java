/* PS5 Screen Share - on-screen controller drawn over the video.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Touches that start on a control belong to the pad; everything else is
 * passed on, so tapping the picture still shows or hides the bars.
 */
package com.ps5screenshare.client;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.RectF;
import android.util.AttributeSet;
import android.view.MotionEvent;
import android.view.View;

public final class PadView extends View {
    interface Listener {
        void onPadState(PadModel.State state);
    }

    private static final int IDLE_ALPHA = 90;
    private static final int PRESSED_ALPHA = 230;

    private final PadModel model = new PadModel();
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint line = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();
    private final RectF rect = new RectF();
    private Listener listener;
    private PadModel.State sent = new PadModel.State();
    private boolean active = true;
    private boolean gesture;

    public PadView(Context c) {
        super(c);
        init();
    }

    public PadView(Context c, AttributeSet a) {
        super(c, a);
        init();
    }

    private void init() {
        line.setStyle(Paint.Style.STROKE);
        line.setColor(0xffffffff);
        fill.setStyle(Paint.Style.FILL);
        fill.setColor(0xffffffff);
        text.setColor(0xffffffff);
        text.setTextAlign(Paint.Align.CENTER);
        text.setFakeBoldText(true);
    }

    void setListener(Listener l) {
        listener = l;
    }

    /** Inactive: nothing is drawn and touches pass through (unavailable console or hidden). */
    void setActive(boolean on) {
        if (active == on) return;
        active = on;
        if (!on) {
            gesture = false;
            model.cancel();
            notifyIfChanged(true);
        }
        invalidate();
    }

    boolean isActive() {
        return active;
    }

    /** True while at least one finger is on a control. */
    boolean isHeld() {
        return model.anyHeld();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        model.layout(w, h);
        float u = Math.min(w, h);
        line.setStrokeWidth(Math.max(2f, 0.008f * u));
        text.setTextSize(0.05f * u);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        if (!active) return;
        PadModel.State s = model.state();
        float u = Math.min(getWidth(), getHeight());
        for (PadModel.Control c : model.controls) {
            boolean pressed = (s.buttons & c.bits) != 0 && c.bits != 0;
            if (c.kind == PadModel.Kind.LEFT_STICK || c.kind == PadModel.Kind.RIGHT_STICK) {
                drawStick(canvas, c, c.kind == PadModel.Kind.LEFT_STICK ? s.lx : s.rx,
                        c.kind == PadModel.Kind.LEFT_STICK ? s.ly : s.ry, u);
                continue;
            }
            int alpha = pressed ? PRESSED_ALPHA : IDLE_ALPHA;
            fill.setAlpha(pressed ? alpha / 2 : 0);
            line.setAlpha(alpha);
            text.setAlpha(alpha);
            if (c.round) {
                canvas.drawCircle(c.cx, c.cy, c.r, fill);
                canvas.drawCircle(c.cx, c.cy, c.r, line);
            } else {
                rect.set(c.left, c.top, c.right, c.bottom);
                canvas.drawRoundRect(rect, 0.02f * u, 0.02f * u, fill);
                canvas.drawRoundRect(rect, 0.02f * u, 0.02f * u, line);
            }
            drawSymbol(canvas, c, u);
        }
    }

    private void drawSymbol(Canvas canvas, PadModel.Control c, float u) {
        float s = c.round ? c.r * 0.5f : 0;
        switch (c.label) {
            case "triangle":
                path.reset();
                path.moveTo(c.cx, c.cy - s);
                path.lineTo(c.cx + s, c.cy + s * 0.8f);
                path.lineTo(c.cx - s, c.cy + s * 0.8f);
                path.close();
                canvas.drawPath(path, line);
                break;
            case "circle":
                canvas.drawCircle(c.cx, c.cy, s, line);
                break;
            case "cross":
                canvas.drawLine(c.cx - s, c.cy - s, c.cx + s, c.cy + s, line);
                canvas.drawLine(c.cx - s, c.cy + s, c.cx + s, c.cy - s, line);
                break;
            case "square":
                rect.set(c.cx - s, c.cy - s, c.cx + s, c.cy + s);
                canvas.drawRect(rect, line);
                break;
            case "up":
            case "down":
            case "left":
            case "right":
                drawArrow(canvas, c, s);
                break;
            default:
                // Text labels (L1, L2, R1, R2, PS, OPTIONS, TOUCH, L3, R3).
                float baseline = c.cy - (text.descent() + text.ascent()) / 2;
                canvas.drawText(c.label.toUpperCase(java.util.Locale.ROOT), c.cx, baseline, text);
                break;
        }
    }

    private void drawArrow(Canvas canvas, PadModel.Control c, float s) {
        path.reset();
        switch (c.label) {
            case "up":
                path.moveTo(c.cx, c.cy - s); path.lineTo(c.cx + s, c.cy + s * 0.5f); path.lineTo(c.cx - s, c.cy + s * 0.5f);
                break;
            case "down":
                path.moveTo(c.cx, c.cy + s); path.lineTo(c.cx + s, c.cy - s * 0.5f); path.lineTo(c.cx - s, c.cy - s * 0.5f);
                break;
            case "left":
                path.moveTo(c.cx - s, c.cy); path.lineTo(c.cx + s * 0.5f, c.cy + s); path.lineTo(c.cx + s * 0.5f, c.cy - s);
                break;
            default: // right
                path.moveTo(c.cx + s, c.cy); path.lineTo(c.cx - s * 0.5f, c.cy + s); path.lineTo(c.cx - s * 0.5f, c.cy - s);
                break;
        }
        path.close();
        canvas.drawPath(path, fill);
    }

    private void drawStick(Canvas canvas, PadModel.Control c, int ax, int ay, float u) {
        boolean moved = ax != 128 || ay != 128;
        line.setAlpha(IDLE_ALPHA + (moved ? 60 : 0));
        canvas.drawCircle(c.cx, c.cy, c.r, line);
        fill.setAlpha(moved ? PRESSED_ALPHA / 2 : IDLE_ALPHA);
        float kx = c.cx + (ax - 128) / 127f * c.r * 0.6f;
        float ky = c.cy + (ay - 128) / 127f * c.r * 0.6f;
        canvas.drawCircle(kx, ky, c.r * 0.35f, fill);
        fill.setAlpha(255);
    }

    @Override
    public boolean performClick() {
        return super.performClick();
    }

    @Override
    public boolean onTouchEvent(MotionEvent e) {
        if (!active) return false;
        boolean force = false;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN: {
                gesture = model.down(e.getPointerId(0), e.getX(0), e.getY(0)) != null;
                if (!gesture) return false; // not ours: let the video take it
                force = true;
                break;
            }
            case MotionEvent.ACTION_POINTER_DOWN: {
                if (!gesture) return false;
                int i = e.getActionIndex();
                model.down(e.getPointerId(i), e.getX(i), e.getY(i));
                force = true;
                break;
            }
            case MotionEvent.ACTION_MOVE: {
                if (!gesture) return false;
                for (int i = 0; i < e.getPointerCount(); i++) {
                    model.move(e.getPointerId(i), e.getX(i), e.getY(i));
                }
                break;
            }
            case MotionEvent.ACTION_POINTER_UP: {
                if (!gesture) return false;
                model.up(e.getPointerId(e.getActionIndex()));
                force = true;
                break;
            }
            case MotionEvent.ACTION_UP: {
                if (!gesture) return false;
                model.up(e.getPointerId(0));
                gesture = false;
                force = true;
                performClick();
                break;
            }
            case MotionEvent.ACTION_CANCEL: {
                if (!gesture) return false;
                model.cancel();
                gesture = false;
                force = true;
                break;
            }
            default:
                return gesture;
        }
        notifyIfChanged(force);
        invalidate();
        return true;
    }

    /** force: send even when nothing changed (press and release always reach the console). */
    private void notifyIfChanged(boolean force) {
        PadModel.State now = model.state();
        if (!force && now.sameAs(sent)) return;
        sent = now.copy();
        if (listener != null) listener.onPadState(sent.copy());
    }
}
