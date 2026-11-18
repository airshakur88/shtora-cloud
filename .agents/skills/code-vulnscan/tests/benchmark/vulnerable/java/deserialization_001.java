// BENCHMARK: vulnerable - deserialization
import jakarta.servlet.http.*;
import java.io.ObjectInputStream;

public class ImportServlet extends HttpServlet {
    protected void doPost(HttpServletRequest request, HttpServletResponse response)
            throws Exception {
        ObjectInputStream stream = new ObjectInputStream(request.getInputStream());
        Object imported = stream.readObject();
        response.getWriter().write("imported");
    }
}
