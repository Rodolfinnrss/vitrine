/* PS5 Screen Share - container that keeps the video aspect ratio.
 * Copyright (C) 2026 PS5 Screen Share contributors
 * SPDX-License-Identifier: GPL-3.0-or-later */
package com.ps5screenshare.client;

import android.content.Context;
import android.util.AttributeSet;
import android.widget.FrameLayout;

public final class AspectFrame extends FrameLayout {
    private double aspect = 16.0 / 9.0;
    private boolean fill;

    public AspectFrame(Context c) {
        super(c);
    }

    public AspectFrame(Context c, AttributeSet a) {
        super(c, a);
    }

    public void setAspect(int width, int height) {
        if (width <= 0 || height <= 0) return;
        double next = (double) width / height;
        if (Math.abs(next - aspect) > 1e-3) {
            aspect = next;
            requestLayout();
        }
    }

    /** true stretches over the whole screen, false letterboxes. */
    public void setFill(boolean f) {
        if (fill != f) {
            fill = f;
            requestLayout();
        }
    }

    public boolean isFill() {
        return fill;
    }

    @Override
    protected void onMeasure(int widthSpec, int heightSpec) {
        int w = MeasureSpec.getSize(widthSpec);
        int h = MeasureSpec.getSize(heightSpec);
        if (!fill && w > 0 && h > 0) {
            if ((double) w / h > aspect) w = (int) Math.round(h * aspect);
            else h = (int) Math.round(w / aspect);
        }
        super.onMeasure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
    }
}
