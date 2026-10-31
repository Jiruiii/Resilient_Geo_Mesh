package com.resilientgeo.mesh.measure

import java.io.File
import java.io.FileOutputStream

/**
 * Append-only CSV for field measurements (docs/finals-field-test-plan.md).
 * Each finished trial is one flushed row, so a killed process keeps every
 * row written before it. New files start with a UTF-8 BOM so spreadsheet
 * apps read the Chinese environment labels correctly.
 */
object MeasurementCsv {
    fun row(values: List<Any?>): String = values.joinToString(",") { escape(it) }

    fun escape(value: Any?): String {
        val text = value?.toString() ?: ""
        return if (text.any { it == ',' || it == '"' || it == '\n' || it == '\r' }) {
            "\"" + text.replace("\"", "\"\"") + "\""
        } else {
            text
        }
    }

    fun append(file: File, header: List<String>, values: List<Any?>) {
        require(header.size == values.size) { "CSV row has ${values.size} values for ${header.size} columns" }
        file.parentFile?.mkdirs()
        val fresh = !file.exists() || file.length() == 0L
        FileOutputStream(file, true).use { stream ->
            stream.bufferedWriter(Charsets.UTF_8).apply {
                if (fresh) write("﻿" + row(header) + "\n")
                write(row(values) + "\n")
                flush()
            }
            stream.fd.sync()
        }
    }
}
