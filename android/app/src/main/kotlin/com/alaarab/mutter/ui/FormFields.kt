package com.alaarab.mutter.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.input.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

@Composable
fun FormField(
    value: String,
    change: (String) -> Unit,
    title: String,
    secret: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
) {
    val p = LocalPalette.current
    BasicTextField(
        value,
        change,
        Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(vertical = 10.dp).semantics {
            contentDescription = title
        },
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = p.ink),
        cursorBrush = SolidColor(p.accent),
        singleLine = true,
        visualTransformation =
            if (secret) PasswordVisualTransformation() else VisualTransformation.None,
        keyboardOptions =
            KeyboardOptions(
                keyboardType = if (secret) KeyboardType.Password else keyboardType,
                imeAction = ImeAction.Done,
            ),
        decorationBox = { field ->
            if (value.isEmpty())
                Text(title, style = MaterialTheme.typography.bodyLarge, color = p.muted)
            field()
        },
    )
}

@Composable
fun DetailRow(title: String, value: String) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.bodyLarge)
        Text(
            value,
            Modifier.weight(1f),
            style = MaterialTheme.typography.bodyMedium,
            color = LocalPalette.current.muted,
            textAlign = TextAlign.End,
        )
    }
}
