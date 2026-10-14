import java.nio.file.*;
import java.sql.*;
import java.util.*;
import java.math.*;
import java.util.Base64;

/**
 * Small read-only JDBC program for .mdb and .accdb.
 * Launch with: java -cp "<UCanAccess and dependency jars>" AccessReader.java mode file table limit offset [columns...]
 * Note: use snapshots of live Access files rather than copying a file being written.
 */
class AccessReader {
    private static String identifier(String value) {
        if (value == null || !value.matches("[\\p{L}\\p{N}_][\\p{L}\\p{N}_ .-]{0,127}")) {
            throw new IllegalArgumentException("Invalid table or column identifier.");
        }
        return "[" + value + "]";
    }

    private static String json(Object value) {
        if (value == null) return "null";
        if (value instanceof byte[]) return json(Base64.getEncoder().encodeToString((byte[]) value));
        if (value instanceof Number || value instanceof Boolean) return value.toString();
        if (value instanceof Map<?, ?>) {
            List<String> parts = new ArrayList<>();
            for (Map.Entry<?, ?> entry : ((Map<?, ?>) value).entrySet())
                parts.add(json(String.valueOf(entry.getKey())) + ":" + json(entry.getValue()));
            return "{" + String.join(",", parts) + "}";
        }
        if (value instanceof Iterable<?>) {
            List<String> parts = new ArrayList<>();
            for (Object item : (Iterable<?>) value) parts.add(json(item));
            return "[" + String.join(",", parts) + "]";
        }
        String s = String.valueOf(value);
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 32) b.append(String.format("\\u%04x", (int)c));
                    else b.append(c);
            }
        }
        return b.append('"').toString();
    }

    public static void main(String[] args) throws Exception {
        if (args.length < 5) throw new IllegalArgumentException("Missing arguments.");
        String operation = args[0];
        Path file = Paths.get(args[1]).toAbsolutePath().normalize();
        if (!Files.isRegularFile(file)) throw new IllegalArgumentException("File does not exist.");
        String table = args[2];
        int limit = Math.max(1, Math.min(5000, Integer.parseInt(args[3])));
        int offset = Math.max(0, Math.min(1000000, Integer.parseInt(args[4])));
        Class.forName("net.ucanaccess.jdbc.UcanaccessDriver");
        String url = "jdbc:ucanaccess://" + file.toString().replace("\\", "/") +
            ";readOnly=true;allowRemoteLinks=false";
        Object output;

        try (Connection conn = DriverManager.getConnection(url)) {
            conn.setReadOnly(true);
            if ("list_tables".equals(operation)) {
                List<Map<String, Object>> list = new ArrayList<>();
                try (ResultSet rs = conn.getMetaData().getTables(null, null, "%", new String[]{"TABLE"})) {
                    while (rs.next() && list.size() < limit) {
                        String name = rs.getString("TABLE_NAME");
                        if (name != null && !name.toLowerCase(Locale.ROOT).startsWith("msys")) {
                            Map<String, Object> row = new LinkedHashMap<>();
                            row.put("name", name);
                            list.add(row);
                        }
                    }
                }
                output = list;
            } else if ("describe_table".equals(operation)) {
                identifier(table);
                List<Map<String, Object>> list = new ArrayList<>();
                try (ResultSet rs = conn.getMetaData().getColumns(null, null, table, "%")) {
                    while (rs.next()) {
                        Map<String, Object> row = new LinkedHashMap<>();
                        row.put("name", rs.getString("COLUMN_NAME"));
                        row.put("type", rs.getString("TYPE_NAME"));
                        row.put("nullable", rs.getInt("NULLABLE") != DatabaseMetaData.columnNoNulls);
                        list.add(row);
                    }
                }
                output = list;
            } else if ("select_rows".equals(operation)) {
                identifier(table);
                List<String> names = new ArrayList<>();
                for (int i = 5; i < args.length; i++) names.add(identifier(args[i]));
                String cols = names.isEmpty() ? "*" : String.join(", ", names);
                // TOP bounds database-side results, then skip offset locally.
                int top = Math.min(1005000, limit + offset);
                String sql = "SELECT TOP " + top + " " + cols + " FROM " + identifier(table);
                List<Map<String, Object>> list = new ArrayList<>();
                try (Statement st = conn.createStatement();
                     ResultSet rs = st.executeQuery(sql)) {
                    ResultSetMetaData meta = rs.getMetaData();
                    int position = 0;
                    while (rs.next()) {
                        if (position++ < offset) continue;
                        Map<String, Object> row = new LinkedHashMap<>();
                        for (int j = 1; j <= meta.getColumnCount(); j++)
                            row.put(meta.getColumnLabel(j), rs.getObject(j));
                        list.add(row);
                        if (list.size() >= limit) break;
                    }
                }
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("count", list.size());
                result.put("rows", list);
                output = result;
            } else {
                throw new IllegalArgumentException("Unsupported operation.");
            }
            System.out.println(json(output));
        }
    }
}
