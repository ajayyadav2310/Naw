package com.moneytrack.personal;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered before super.onCreate().
        registerPlugin(MoneyTrackBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
