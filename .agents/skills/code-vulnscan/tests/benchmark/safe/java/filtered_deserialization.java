// BENCHMARK: safe - JEP 290 allowlist filter before deserialization
import java.io.*;

public class SafeImporter {
    public Object read(InputStream trustedStream) throws Exception {
        ObjectInputStream stream = new ObjectInputStream(trustedStream);
        ObjectInputFilter filter = ObjectInputFilter.Config.createFilter(
            "com.example.dto.*;java.base/*;!*"
        );
        stream.setObjectInputFilter(filter);
        return stream.readObject();
    }
}
